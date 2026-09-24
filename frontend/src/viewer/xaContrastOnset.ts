/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA シネで**造影剤の到達フレームを見つける**（`fw/angio-design.md` §6.8）。**純関数だけ**。
 *
 * <h3>なぜ 3 つ目の検出器なのか</h3>
 * §6.3 に「検出信号を 2 回作り直した」記録がある。どちらも**静止した背景にボーラスが入る
 * ファントム**で直したもので、**拍動する実データは想定外**だった。実機（Rubo Run1・137 フレーム・
 * 25fps）で測ると、既存の `dsa.ts:contrastDropSignal()` ＋ `pickMaskFrames()` は
 * **造影到達をまったく検出できない**（`onset = null` でラン先頭へフォールバック）。
 *
 * <p>🔴 **原因は「先頭 5 フレームを基線にする」という設計そのもの。** 実際の XA は
 * **先頭 10 フレームが露出の立ち上がり**で、基線がそこに掛かると sd が膨らんで閾値が届かなくなる。
 * 実測:
 * <pre>
 *   contrastDropSignal : 0:-16 1:-16 2:-38 3:-55 4:-60 5:-66 … 10:-83
 *   基線(先頭5)        : 平均 -37 / sd 18.6 → 閾値 +37.5   ← 一度も超えない
 * </pre>
 *
 * <p>🔴 **既存の 2 つは置き換えない。** DSA の既定経路（`pickMaskFrames`）は GNBP-XA-2 の
 * 実機 17/0 と `dsa.test.ts` が固定している。ここは**自動同位相 DSA からだけ**使う。
 *
 * <h3>実測した曲線（中央 ROI の 10 パーセンタイル・Rubo Run1）</h3>
 * <pre>
 *   0〜10   103 → 49   露出の立ち上がり（隣接差 −15〜−2 と大きい）
 *   11〜39  49 → 60 → 55 前後   造影前のプラトー（心拍のさざ波 ±3）
 *   40〜    53 → 35 前後        造影が入って低下
 * </pre>
 * 隣接差の絶対値の中央値は**全体で 1.0**。露出ランプだけが桁違いに大きい。
 */

import { clampRect, type PixelRect } from "./edgeFilters";

export interface ContrastOnsetOptions {
  /** 信号を取る中央 ROI の割合（既定 0.5 ＝ 画面の中央半分）。 */
  centerFraction?: number;
  /**
   * 見るパーセンタイル（既定 0.10）。
   * 🔴 **0.02 ではない。** 実測で p02 は 43→29 と鈍く、**p10 は 56→32** とはっきり動く
   * （p02 は骨と飽和に食われる。§6.3 の「2 版」が骨で壊れたのと同じ理由）。
   */
  quantile?: number;
  /** 画素の間引き（既定 2）。 */
  stride?: number;
  /** 平滑化（移動中央値）の窓 [ms]（既定 300）。**平均ではなく中央値**——立ち上がりを鈍らせない。 */
  smoothMs?: number;
  /** 基線に使う長さ [ms]（既定 800 ＝ およそ 1 心拍）。 */
  baselineMs?: number;
  /** 閾値 = 基線中央値 − k × MAD（既定 3）。 */
  k?: number;
  /** 何フレーム続けて閾値を下回ったら到達とみなすか（既定 3）。単発のスパイクで発火しない。 */
  sustainFrames?: number;
}

export interface ContrastOnsetResult {
  /** 造影到達フレーム（0 origin）。判定できなければ null。 */
  onset: number | null;
  /** 露出が安定したとみなしたフレーム。**ここより前は使わない**。 */
  stableFrom: number;
  /** マスクに使ってよいフレーム `[stableFrom, onset)`。判定できなければ空。 */
  preContrast: number[];
  /** 各フレームの低パーセンタイル（生）。 */
  signal: number[];
  /** 平滑化後。 */
  smoothed: number[];
  baselineMedian: number;
  baselineMad: number;
  threshold: number;
  reason?: "tooShort" | "noSustainedDrop";
}

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}

/** 中央絶対偏差。標準偏差と違い、**外れ値（造影が混ざったフレーム）に引きずられない**。 */
function mad(xs: readonly number[], center: number): number {
  return median(xs.map((x) => Math.abs(x - center)));
}

/** 移動中央値（端は窓を縮める）。 */
function movingMedian(xs: readonly number[], window: number): number[] {
  const w = Math.max(1, Math.floor(window));
  if (w <= 1) return [...xs];
  const half = w >> 1;
  return xs.map((_, i) => median(xs.slice(Math.max(0, i - half), Math.min(xs.length, i + half + 1))));
}

/**
 * 中央 ROI の低パーセンタイルを 1 フレーム 1 個の数値にする。
 *
 * <p>🚨 **値がちょうど 0 の画素は外す。** XA はコリメータの外が 0 で埋まっており
 * （実データで画面の 20%）、外さないと低パーセンタイルが**全フレームで 0** になって
 * 何も検出しなくなる（`dsa.ts:contrastSignal()` が踏んだのと同じ罠）。
 */
export function lowPercentileSignal(
  frames: readonly Float32Array[],
  width: number,
  height: number,
  opts: ContrastOnsetOptions = {},
): number[] {
  const frac = Math.min(1, Math.max(0.1, opts.centerFraction ?? 0.5));
  const q = Math.min(0.5, Math.max(0.001, opts.quantile ?? 0.10));
  const st = Math.max(1, Math.floor(opts.stride ?? 2));
  const rect: PixelRect = clampRect(
    {
      x0: Math.round((width * (1 - frac)) / 2),
      y0: Math.round((height * (1 - frac)) / 2),
      x1: Math.round(width - (width * (1 - frac)) / 2) - 1,
      y1: Math.round(height - (height * (1 - frac)) / 2) - 1,
    },
    width,
    height,
  );
  return frames.map((f) => {
    const v: number[] = [];
    for (let y = rect.y0; y <= rect.y1; y += st) {
      const row = y * width;
      for (let x = rect.x0; x <= rect.x1; x += st) {
        const p = f[row + x];
        if (p !== 0) v.push(p);
      }
    }
    if (!v.length) return 0;
    v.sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(v.length * q))];
  });
}

/**
 * 🔴 **露出の立ち上がり区間を見つける。**
 *
 * <p>先頭から「**単調に下がり、かつ 1 フレームあたりの変化が普段より桁違いに大きい**」間を
 * ランプとみなす。**ここを捨てないと基線が汚れて閾値が届かない**——それが既存の検出器が
 * 実データで失敗していた理由そのものである。
 *
 * <p>暴走しないよう**ランの 15% を上限**にする。造影が最初から入っているラン
 * （§6.6.2 の Rubo 0002）では、ここが伸びきっても後段が「造影前が無い」と判定するので、
 * 黙って誤検出するより安全側に倒れる。
 */
function exposureRampEnd(signal: readonly number[]): number {
  const n = signal.length;
  if (n < 4) return 0;
  const diffs: number[] = [];
  for (let i = 1; i < n; i++) diffs.push(Math.abs(signal[i] - signal[i - 1]));
  const typical = Math.max(median(diffs), 0.5);
  const limit = Math.max(2 * typical, 1);
  const maxRamp = Math.max(2, Math.floor(n * 0.15));
  let i = 0;
  while (i < maxRamp && i < n - 1) {
    const step = signal[i + 1] - signal[i];
    if (step < 0 && Math.abs(step) > limit) i++;
    else break;
  }
  return i;
}

/**
 * 数列から造影到達を見つける（画像に触らない部分）。
 *
 * <p>画像を持たずに検査できるよう分けてある。`xaContrastOnset.test.ts` には
 * **実機で測った 137 フレームの曲線がそのまま入れてある**。
 */
export function detectOnsetFromSignal(
  signal: readonly number[],
  frameStartTimesMs: readonly number[],
  opts: ContrastOnsetOptions = {},
): ContrastOnsetResult {
  const n = signal.length;
  const empty = (reason: ContrastOnsetResult["reason"], stableFrom = 0): ContrastOnsetResult => ({
    onset: null, stableFrom, preContrast: [], signal: [...signal], smoothed: [...signal],
    baselineMedian: 0, baselineMad: 0, threshold: 0, ...(reason ? { reason } : {}),
  });
  if (n < 8) return empty("tooShort");

  const span = frameStartTimesMs.length >= 2
    ? (frameStartTimesMs[frameStartTimesMs.length - 1] - frameStartTimesMs[0]) / (frameStartTimesMs.length - 1)
    : 0;
  const dtMs = span > 0 ? span : 1000 / 15;

  const smoothWin = Math.max(1, Math.round((opts.smoothMs ?? 300) / dtMs));
  const smoothed = movingMedian(signal, smoothWin);

  const stableFrom = exposureRampEnd(smoothed);
  const baselineLen = Math.min(
    Math.max(8, Math.round((opts.baselineMs ?? 800) / dtMs)),
    Math.max(8, Math.floor(n * 0.25)),
  );
  if (stableFrom + baselineLen >= n) return empty("tooShort", stableFrom);

  const baseline = smoothed.slice(stableFrom, stableFrom + baselineLen);
  const center = median(baseline);
  const spread = Math.max(mad(baseline, center), 1);
  const k = opts.k ?? 3;
  const threshold = center - k * spread;
  const sustain = Math.max(1, Math.floor(opts.sustainFrames ?? 3));

  let onset: number | null = null;
  for (let i = stableFrom + baselineLen; i + sustain <= n; i++) {
    let all = true;
    for (let j = 0; j < sustain; j++) if (!(smoothed[i + j] < threshold)) { all = false; break; }
    if (all) { onset = i; break; }
  }

  const base = {
    stableFrom, signal: [...signal], smoothed,
    baselineMedian: center, baselineMad: spread, threshold,
  };
  if (onset == null) return { ...base, onset: null, preContrast: [], reason: "noSustainedDrop" };
  const preContrast: number[] = [];
  for (let i = stableFrom; i < onset; i++) preContrast.push(i);
  return { ...base, onset, preContrast };
}

/* ------------------------------------------------------------------ */
/* 造影が「本当に」始まるフレーム（§6.10・Phase 6）                       */
/* ------------------------------------------------------------------ */

/**
 * 🔴 対数を取るときのゼロ除け。**`dsa.ts` の `LOG_EPS` と同じ値**にしてある
 * （差分の見え方を合わせるため。片方だけ変えると閾値の意味がずれる）。
 */
export const LOG_EPS = 1e-3;

/**
 * コリメータ際を外すための下限。**ちょうど 0 を外すだけでは足りない。**
 *
 * <p>🚨 境界の画素は片方で 1 カウント、もう片方で 0 という組み合わせになりやすく、対数域では
 * `log(1+ε) − log(ε)` という桁違いの差を作る。実機（Rubo Run1）でこれを入れないと、
 * 基準値が 0.36% → 0.40% に膨らんで閾値が上がり、**造影開始の判定が 5 フレーム遅れた**
 * （1-origin 33 → 38）。0.01〜0.05 のどこでも 33 に落ち着くので 0.02 にしてある。
 */
export const FIELD_FLOOR_FRACTION = 0.02;

/**
 * マスクとの差を**間引いて取り出し、中央値を引いたもの**（＝レベル合わせ後）。
 *
 * <p>🚨 **コリメータの外とその際を外す。** 外は 0 で埋まっており（実データで画面の 20%）、
 * 際の 1 カウント画素は対数域で桁違いの差を作る（{@link FIELD_FLOOR_FRACTION}）。
 *
 * <p>返すのは分布そのもの。呼び出し側が {@link robustSpread}（床の自己較正）と
 * {@link darkenedFraction}（造影の検出）に使う。2 度走査しないで済むように分けてある。
 */
export function levelMatchedDifference(
  mask: Float32Array,
  frame: Float32Array,
  logarithmic: boolean,
  stride = 2,
): Float64Array {
  const st = Math.max(1, Math.floor(stride));
  const n = Math.min(mask.length, frame.length);

  // 視野の代表値（0 を除いた中央値）から下限を決める。ビット深度に依らない。
  const lit: number[] = [];
  for (let i = 0; i < n; i += st) if (mask[i] > 0) lit.push(mask[i]);
  const floor = lit.length ? Math.max(1, median(lit) * FIELD_FLOOR_FRACTION) : 0;

  const buf: number[] = [];
  for (let i = 0; i < n; i += st) {
    const m = mask[i];
    const f = frame[i];
    if (!(m > floor) || !(f > floor)) continue;
    buf.push(logarithmic
      ? Math.log(Math.max(m, 0) + LOG_EPS) - Math.log(Math.max(f, 0) + LOG_EPS)
      : m - f);
  }
  const out = Float64Array.from(buf);
  if (!out.length) return out;
  const sorted = Float64Array.from(out).sort();
  const h = sorted.length >> 1;
  const med = sorted.length % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2;
  for (let i = 0; i < out.length; i++) out[i] -= med;
  return out;
}

/**
 * ロバストな散らばり（MAD × 1.4826）。**ノイズの床を自己較正する**のに使う。
 *
 * <p>床は素材で決まる。実測（Rubo `0009.DCM`・8bit・非可逆圧縮）で **0.038**、
 * これは 8bit 量子化の 1 段（p10=24 で 0.041）とほぼ同じだった。
 * 臨床の 10〜12bit ならずっと小さいので、**定数で決め打たない**。
 */
export function robustSpread(values: Float64Array): number {
  if (values.length < 4) return 0;
  const abs = Float64Array.from(values, Math.abs).sort();
  const h = abs.length >> 1;
  const m = abs.length % 2 ? abs[h] : (abs[h - 1] + abs[h]) / 2;
  return m * 1.4826;
}

/** `threshold` より**暗い**画素の割合（造影は減衰を増やす＝マスクより暗くなる）。 */
export function darkenedFraction(values: Float64Array, threshold: number): number {
  if (!values.length) return 0;
  let k = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > threshold) k++;
  return k / values.length;
}

/** {@link contrastStartFromFractions} の設定。 */
export interface ContrastStartOptions {
  /** 基準値の何倍を超えたら造影とみなすか（既定 3）。 */
  factor?: number;
  /** 判定の下限（既定 0.003 ＝ 0.3%）。基準値が 0 に近いランで暴発しないため。 */
  floorFraction?: number;
}

/**
 * 暗化画素の割合の列から、**造影が本当に始まるフレーム**を返す。
 *
 * <h3>🚨 なぜ必要か</h3>
 * {@link detectOnsetFromSignal} は中央 ROI の p10 が**持続的に**下がったところで発火する。
 * 冠動脈の造影は画面の 1% しか占めないので、**p10 が動くのは造影がかなり進んでから**である。
 * 実測（Rubo Run1）で、暗化画素の割合は **1-origin 33** で基準値へ戻らなくなるのに、
 * p10 の onset は **42** ——**9 フレーム遅い**。その 9 枚は
 * <ul>
 *   <li>造影前とみなされて**自己差分＝真っ黒**になり、**立ち上がりが見えない**</li>
 *   <li>**マスク候補にもなる**ので、薄い血管影がマスクに混ざる</li>
 * </ul>
 *
 * <h3>規則</h3>
 * 「**ここから `to` まで一度も基準値へ戻らない**」最小のフレームを返す（`to` から手前へ歩く）。
 * 単発の跳ねで手前へ行きすぎない。
 *
 * <p>🔑 **迷ったら手前に倒す。** 造影を隠すより、マスク候補が 1〜2 枚減るほうがはるかにまし。
 *
 * @param fractions 絶対フレーム番号で引ける割合の列（`[from, to]` の範囲だけ埋まっていればよい）
 */
export function contrastStartFromFractions(
  fractions: readonly number[],
  from: number,
  to: number,
  opts: ContrastStartOptions = {},
): number {
  const factor = opts.factor ?? 3;
  const floorFraction = opts.floorFraction ?? 0.003;
  if (to <= from) return to;

  // 基準値は前半の中央値（後半は造影が入りかけているかもしれない）。
  const half = from + Math.max(1, Math.floor((to - from) / 2));
  const base: number[] = [];
  for (let t = from; t < half; t++) base.push(fractions[t] ?? 0);
  const limit = Math.max(median(base) * factor, floorFraction);

  let start = to;
  for (let t = to; t >= from; t--) {
    if ((fractions[t] ?? 0) > limit) start = t;
    else break;
  }
  return start;
}

/**
 * ROI 調査に使う窓と、そのうち**造影が混ざっていない接頭辞**を返す（§6.15）。
 *
 * <p>🚨 **この 2 つは一致しない。** `window` は粗い onset までの造影前フレームだが、
 * `surveyFrames` は**絞り込んだ `contrastStart` より前**しかない。§6.10.2 のとおり
 * p10 由来の onset は冠動脈では遅れる（実機で 9 フレーム）ので、
 * **絞り込みが効いている＝正常系では必ず `surveyFrames.length < window.length` になる。**
 *
 * <p>🔴 **`surveyFrames` は `window` の接頭辞である。** `roughPre` は連続昇順で、
 * `contrastStart` は閾値カットなので、前から数えた何枚かがそのまま残る。
 * これは呼び出し側が**画素を `window` の順に詰めてから先頭 `surveyFrames.length` 枚を
 * 切り出す**ことに依存している不変条件なので、ここで一緒に返して取り違えを防ぐ。
 *
 * <p>以前は呼び出し側が「枚数」と「時刻の配列」を**別々の式**から作っていたため、
 * 時刻だけ `window` の長さになり、受け側で黙って捨てられていた（§6.15 の元凶）。
 *
 * @param roughPre     粗い造影前区間（連続昇順）
 * @param contrastStart 絞り込んだ造影開始フレーム
 * @param maxFrames    窓の上限（超えるときは **onset 側に寄せて**連続した窓を取る）
 */
export function roiSurveyWindow(
  roughPre: readonly number[],
  contrastStart: number,
  maxFrames: number,
): { window: number[]; surveyFrames: number[] } {
  const window = roughPre.length <= maxFrames
    ? [...roughPre]
    : roughPre.slice(roughPre.length - maxFrames);
  return { window, surveyFrames: window.filter((t) => t < contrastStart) };
}

/** 画像から造影到達まで一息で。 */
export function detectContrastOnset(
  frames: readonly Float32Array[],
  width: number,
  height: number,
  frameStartTimesMs: readonly number[],
  opts: ContrastOnsetOptions = {},
): ContrastOnsetResult {
  return detectOnsetFromSignal(lowPercentileSignal(frames, width, height, opts), frameStartTimesMs, opts);
}
