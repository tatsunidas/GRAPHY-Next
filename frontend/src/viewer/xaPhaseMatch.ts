/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 同位相マスクを**背景の突き合わせ**で決める（`fw/angio-design.md` §6.16）。**純関数だけ**。
 *
 * <h3>🔑 なぜ運動信号を経由しないのか</h3>
 * §6.11.4 の緊張関係——**合わせたいのは心臓だが、心臓は造影剤が流れ込む場所でもある**——は、
 * 「**追う対象を選ぶ**」ことを前提にしていた。実データ（Rubo Run 1）で総当たりした結果、
 * 心陰影の内側は造影後 5〜15% しか追えず、造影に強い金属クリップは振幅 0.7px しか持たない。
 * どちらも成立しない。
 *
 * <p>利用者の提案「**造影の様相でペアリングできるとよい**」に沿って測ったところ、
 * **位相を経由する必要すら無い**ことが分かった。ライブフレームごとに
 * 「**造影で変わった画素を除いて、背景がいちばん似た造影前フレーム**」を選べばよい。
 *
 * <p>ECG（`R Wave Pointer` = 16.62 フレーム = 90.2 bpm）を真値とした実測:
 * <pre>
 *                        位相の誤差(中央値)   0.1 周期以内
 *   背景の突き合わせ          0.051              71%
 *   でたらめに選ぶ              —                14%
 * </pre>
 *
 * <p>🔑 **これで要らなくなるもの**: 運動信号・**ROI の選択**・2 つの信号をアフィンで繋ぐこと・
 * その符号の決定。選ばなければ矛盾しない。
 *
 * <p>🔑 背景には心位相と呼吸位相の**両方**が入っているので、位相を経由するより素直に
 * 「解剖がいちばん合うマスク」を選んでいる。DSA が欲しいのはまさにそれである。
 *
 * <h3>🔴 捨てた道（実測で否定済み・もう試さないこと）</h3>
 * 「造影由来の運動信号を作って造影前の背景信号とアフィンで繋ぐ」案は、**信号自体は良かった**
 * （差分画像の ZNCC 追尾で造影後 102/105・周期 17f・r=0.950・ECG との R²=0.824）。
 * 繋げなかったのは橋渡しが 3 通りとも潰れたため——①時間的な重なりは**造影開始後 1 フレーム**
 * しか無い ②振幅レンジの当てはめは倍率は出るが**符号が決まらない** ③波形の歪度で符号を
 * 決める案は**偶然と同じ**（4 組中 2 組）。
 */
import { clampRect, sobelGradients, type PixelRect } from "./edgeFilters";
import { FIELD_FLOOR_FRACTION, LOG_EPS } from "./xaContrastOnset";

/**
 * 突き合わせに使う画素。**勾配成分 2ch**を想定している（§6.7.2 で輝度より 4 倍正確と実測）。
 *
 * <p>チャンネル `p` の画素 `(x, y)`（フレーム `f`）は
 * `data[((f * planes + p) * height + y) * width + x]`。
 */
export interface PhaseMatchFrames {
  data: Float32Array;
  width: number;
  height: number;
  planes: number;
  frameCount: number;
}

/**
 * 除外マスク付きの ZNCC。`include[y * width + x]` が 0 の画素は**どのチャンネルでも**使わない。
 *
 * <p>🔴 {@link ../xaTracking.znccPrepared} と式は同じだが、あちらは矩形の全画素を舐めるので
 * 除外を受けられない。**あちらは変更しない**（追尾の数値が動くため）。
 *
 * @returns −1..1。比べられる画素が少なすぎるときは 0
 */
export function znccMasked(
  frames: PhaseMatchFrames,
  aIndex: number,
  bIndex: number,
  rect: PixelRect,
  include: Uint8Array | null,
  minPixels = 200,
): number {
  const { data, width, height, planes } = frames;
  if (aIndex < 0 || bIndex < 0 || aIndex >= frames.frameCount || bIndex >= frames.frameCount) return 0;
  const r = clampRect(rect, width, height);

  const planeSize = width * height;
  const aBase = aIndex * planes * planeSize;
  const bBase = bIndex * planes * planeSize;

  let n = 0;
  let sA = 0, sB = 0, sAA = 0, sBB = 0, sAB = 0;
  for (let p = 0; p < planes; p++) {
    const ap = aBase + p * planeSize;
    const bp = bBase + p * planeSize;
    for (let y = r.y0; y <= r.y1; y++) {
      const row = y * width;
      for (let x = r.x0; x <= r.x1; x++) {
        const i = row + x;
        if (include && !include[i]) continue;
        const va = data[ap + i];
        const vb = data[bp + i];
        sA += va; sB += vb;
        sAA += va * va; sBB += vb * vb; sAB += va * vb;
        n++;
      }
    }
  }
  if (n < minPixels) return 0;
  const ma = sA / n;
  const mb = sB / n;
  const cov = sAB - n * ma * mb;
  const den = Math.sqrt((sAA - n * ma * ma) * (sBB - n * mb * mb));
  return den > 1e-12 ? cov / den : 0;
}

/** 1 つのライブフレームに対する突き合わせの結果。 */
export interface PhaseMatchEntry {
  liveFrame: number;
  /** 選ばれたマスクフレーム（候補が無ければ null）。 */
  maskFrame: number | null;
  /** そのときの ZNCC。 */
  score: number;
  /** 2 位との差。小さいほど「どれでもよかった」＝選択が効いていない。 */
  margin: number;
  /** 比べるのに使った画素の割合（除外後）。小さいと ZNCC が不安定になる。 */
  usedFraction: number;
}

export interface PhaseMatchOptions {
  /**
   * 比べる画素が矩形の何割を下回ったら諦めるか（既定 0.5）。
   *
   * <p>🚨 造影が濃いと除外画素が増える（実機で最大 7.8%）。減りすぎた状態の ZNCC は
   * 当てにならないので、**黙って低い値を返さず null にする**。
   */
  minUsedFraction?: number;
  /** ZNCC に要る最小画素数（既定 200）。 */
  minPixels?: number;
}

/**
 * ライブフレームごとに、**背景がいちばん似た**マスクフレームを選ぶ。
 *
 * <p>🔴 **候補を絞らない。** 使えるマスクフレームを全部試す。振幅で k 個に絞る従来の経路は
 * 造影後に運動信号が作れないので使えないし、絞る理由も無い（実測で 105×32 = 3360 回の
 * ZNCC は半解像度なら数秒で収まる）。
 *
 * @param excludeFor ライブフレームごとの**除外**マスク（造影で変わった画素。`null` なら除外しない）
 */
export function matchByBackground(
  frames: PhaseMatchFrames,
  liveFrames: readonly number[],
  maskFrames: readonly number[],
  rect: PixelRect,
  excludeFor: (liveFrame: number) => Uint8Array | null,
  opts: PhaseMatchOptions = {},
): PhaseMatchEntry[] {
  const minUsed = opts.minUsedFraction ?? 0.5;
  const minPixels = opts.minPixels ?? 200;
  const r = clampRect(rect, frames.width, frames.height);
  const rectPixels = (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

  const out: PhaseMatchEntry[] = [];
  const include = new Uint8Array(frames.width * frames.height);

  for (const t of liveFrames) {
    const exclude = excludeFor(t);
    let used = 0;
    include.fill(0);
    for (let y = r.y0; y <= r.y1; y++) {
      const row = y * frames.width;
      for (let x = r.x0; x <= r.x1; x++) {
        const i = row + x;
        if (exclude && exclude[i]) continue;
        include[i] = 1;
        used++;
      }
    }
    const usedFraction = rectPixels > 0 ? used / rectPixels : 0;
    if (usedFraction < minUsed || used < minPixels) {
      out.push({ liveFrame: t, maskFrame: null, score: 0, margin: 0, usedFraction });
      continue;
    }

    let best = -Infinity;
    let second = -Infinity;
    let bestM = -1;
    for (const m of maskFrames) {
      const s = znccMasked(frames, t, m, r, include, minPixels);
      // 🔴 同点は若いフレームを採る（決定性のため。§6.7 の matchByAmplitude と同じ作法）。
      if (s > best) { second = best; best = s; bestM = m; }
      else if (s > second) { second = s; }
    }
    out.push({
      liveFrame: t,
      maskFrame: bestM >= 0 ? bestM : null,
      score: bestM >= 0 ? best : 0,
      margin: Number.isFinite(second) ? best - second : 0,
      usedFraction,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 造影で変わった画素（＝比べるときに外すもの）                          */
/* ------------------------------------------------------------------ */

function medianOf(v: Float64Array | number[]): number {
  if (!v.length) return 0;
  const a = Float64Array.from(v).sort();
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}

export interface ContrastMaskResult {
  /** 1 = 造影で変わった画素（比べるときに外す）。 */
  exclude: Uint8Array;
  /** 視野のうち外した割合。 */
  fraction: number;
}

/**
 * マスクとの差から「はっきり暗くなった画素」を拾う。
 *
 * <p>🔴 **規則は {@link ../xaContrastOnset.levelMatchedDifference} と
 * {@link ../xaContrastOnset.darkenedFraction} に揃えてある**——視野の下限、レベル合わせ（中央値を引く）、
 * MAD による床の自己較正、4σ。定数も同じものを import している。あちらは造影到達の検出に使う
 * ために**位置を捨てて 1 本に詰める**ので、位置の要るこちらでは同じ式を空間のまま計算する。
 *
 * @param sigma 床の何倍を「はっきり暗い」とするか（既定 4。§6.10.2 の実測値）
 */
export function contrastMask(
  mask: Float32Array,
  frame: Float32Array,
  width: number,
  height: number,
  logarithmic: boolean,
  sigma = 4,
): ContrastMaskResult {
  const n = Math.min(mask.length, frame.length, width * height);
  const exclude = new Uint8Array(width * height);

  // 視野の代表値（0 を除いた中央値）から下限を決める。ビット深度に依らない。
  const lit: number[] = [];
  for (let i = 0; i < n; i += 2) if (mask[i] > 0) lit.push(mask[i]);
  const floor = lit.length ? Math.max(1, medianOf(lit) * FIELD_FLOOR_FRACTION) : 0;

  const d = new Float64Array(n);
  const valid = new Uint8Array(n);
  const sample: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = mask[i];
    const f = frame[i];
    if (!(m > floor) || !(f > floor)) continue;
    valid[i] = 1;
    d[i] = logarithmic
      ? Math.log(Math.max(m, 0) + LOG_EPS) - Math.log(Math.max(f, 0) + LOG_EPS)
      : m - f;
    if (i % 2 === 0) sample.push(d[i]);
  }
  if (!sample.length) return { exclude, fraction: 0 };

  const med = medianOf(sample);
  // 床は MAD から自己較正する（素材で決まるので定数にしない）。
  const spread = medianOf(sample.map((v) => Math.abs(v - med))) * 1.4826;
  const threshold = sigma * spread;

  let hit = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    count++;
    if (d[i] - med > threshold) { exclude[i] = 1; hit++; }
  }
  return { exclude, fraction: count ? hit / count : 0 };
}

/**
 * 造影が現れた範囲を少し広げた矩形。**突き合わせの窓**に使う。
 *
 * <p>🚨 **全画面で比べてはいけない。** 静止した背骨・コリメータ・体外の領域が大半を占めると、
 * 心臓の動きが数値に出ない——実測で、造影前フレームを全画面 ZNCC で追うと
 * **変位 0.00px**（＝どのフレームも同じに見える）になった。造影が現れる範囲は心臓の
 * 在りかそのものなので、そこを窓にする。
 */
export function contrastBounds(
  masks: readonly Uint8Array[],
  width: number,
  height: number,
  pad = 20,
): PixelRect | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (const m of masks) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (!m[row + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return clampRect(
    { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad },
    width,
    height,
  );
}

/**
 * フレーム列を**勾配成分 2ch** に直して {@link PhaseMatchFrames} に詰める。
 *
 * <p>🔴 **勾配「強度」ではなく成分**（§6.7.2。強度は非線形でサブピクセルが崩れる。
 * 実測で 0.26px 対 0.07px）。`edgeFilters.sobelGradients` をそのまま使う。
 */
export function packGradients(
  frames: readonly Float32Array[],
  width: number,
  height: number,
): PhaseMatchFrames {
  const planeSize = width * height;
  const data = new Float32Array(frames.length * 2 * planeSize);
  frames.forEach((f, i) => {
    const { gx, gy } = sobelGradients(f, width, height);
    data.set(gx, (i * 2) * planeSize);
    data.set(gy, (i * 2 + 1) * planeSize);
  });
  return { data, width, height, planes: 2, frameCount: frames.length };
}

/* ------------------------------------------------------------------ */
/* マスク源の判別（§6.19）                                              */
/* ------------------------------------------------------------------ */

/**
 * フレーム列の**画素ごとの時間中央値**。血管の無い背景の近似。
 *
 * <p>🔑 **造影前フレームを 1 枚も必要としない。** 血管は一部のフレームにしか無く、しかも
 * 心拍で動くので、時間方向の中央値は血管を外して背景に寄る。造影前が無いラン
 * （CASE01 LAD）では「造影前の平均」が作れないので、基準はこれで作る。
 *
 * <p>⚠️ **半解像度で呼ぶこと。** 全解像度 × 全フレームを画素ごとにソートすると重い。
 */
export function temporalMedian(
  frames: readonly Float32Array[],
  width: number,
  height: number,
): Float32Array {
  const n = frames.length;
  const size = width * height;
  const out = new Float32Array(size);
  if (!n) return out;
  const buf = new Float64Array(n);
  const half = n >> 1;
  for (let i = 0; i < size; i++) {
    for (let t = 0; t < n; t++) buf[t] = frames[t][i];
    const sorted = Float64Array.from(buf).sort();
    out[i] = n % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
  }
  return out;
}

/** フレームごとの「造影で変わった画素の割合」。 */
export function contrastFractions(
  frames: readonly Float32Array[],
  reference: Float32Array,
  width: number,
  height: number,
  logarithmic: boolean,
  sigma = 4,
): number[] {
  return frames.map((f) => contrastMask(reference, f, width, height, logarithmic, sigma).fraction);
}

/** マスクにできるのは何か。 */
export type MaskSourceKind = "preContrast" | "washout" | "none";

export interface MaskSourceEvidence {
  /** 先頭の水準（造影量の割合）。 */
  leadingLevel: number;
  /** ピークの水準と、その位置。 */
  peakLevel: number;
  peakFrame: number;
  /** 末尾の水準。 */
  trailingLevel: number;
  /** 判定に使った閾値（割合そのもの）。 */
  threshold: number;
}

export interface MaskSourceResult {
  kind: MaskSourceKind;
  /** マスクに使える層のフレーム番号（`kind === "none"` なら空）。 */
  frames: number[];
  /** 🔑 **なぜそう判断したか。** 画面に出して、外したときに追えるようにする。 */
  evidence: MaskSourceEvidence;
}

export interface ClassifyOptions {
  /** 先頭・末尾の水準を測る枚数の割合（既定 0.1・最低 3 枚）。 */
  edgeFraction?: number;
  /**
   * 「造影前がある」と呼ぶ、先頭とピークの比（既定 0.3）。
   *
   * <p>実測（CASE01 `00000003`）で先頭 0.56% ／ ピーク 5.64% ＝ **0.099**。
   * 最初から造影が入っているランではこの比が 1 に近づく。0.3 は両者の間に十分な余裕がある。
   */
  preContrastRatio?: number;
  /** 「washout した」と呼ぶ、末尾とピークの比（既定 0.4。実測 0.243）。 */
  washoutRatio?: number;
  /** 層として認める最小の枚数（既定 8）。 */
  minFrames?: number;
  /**
   * 境界を動かすのに要る**連続した**フレーム数（既定 3）。
   *
   * <p>🚨 **単発の跳ねで境界を動かさない。** 実測（CASE01 `00000003`）で先頭 f0 だけが
   * 1.89%（閾値 1.69%）と跳ねており、「フレーム 0 から連続で閾値以下」という条件は
   * **1 枚目で切れて**造影前を 0 枚と判定した。先頭の水準（0.56% ＝ ピークの 10%）は
   * 明らかに造影前なのに、層の取り方が脆かった。
   * `xaContrastOnset.contrastStartFromFractions` が同じ教訓で持っている作法に揃える。
   */
  sustainFrames?: number;
}

/**
 * **造影前があるのか、造影後しか無いのかを判別する**（§6.19）。
 *
 * <h3>🚨 `preContrast.length < 8` で判断してはいけない</h3>
 * あれは推論であって判別ではない。`xaContrastOnset.detectOnsetFromSignal` は
 * 「**ランが造影前から始まる**」前提で作られた検出器なので、最初から造影が入っているランでは
 * **出力そのものが当てにならない**（それらしい値を返してしまう）。
 * 「造影前が 8 枚未満だった」は「造影前が無い」の証拠にならない。
 *
 * <h3>判別はフレーム番号ではなく時系列の形で決める</h3>
 * <pre>
 *   先頭が低く、そのあと上がる          → preContrast（先頭側を使う）
 *   先頭から既に高いが、ピークの後ろで下げ止まる → washout（末尾側を使う）
 *   どちらも無い                        → none（降りる。無理に当てない）
 * </pre>
 *
 * <p>🚨 **「割合が低い」だけで層を決めない。** 造影前の立ち上がりも低いので、
 * `washout` には**ピークより後ろ**という条件が要る。だから判別と層の抽出を同じ関数に置く。
 *
 * <p>🔴 **混ぜない。** 造影前と washout 層では**残っている血管の量が違う**（実測で
 * 最小 0.42% に対し末尾 1.2〜2.0%）。混ぜるとマスクごとに残存量が変わり、一貫しない。
 */
export function classifyMaskSource(
  fractions: readonly number[],
  opts: ClassifyOptions = {},
): MaskSourceResult {
  const n = fractions.length;
  const edge = Math.max(3, Math.floor(n * (opts.edgeFraction ?? 0.1)));
  const preRatio = opts.preContrastRatio ?? 0.3;
  const washRatio = opts.washoutRatio ?? 0.4;
  const minFrames = Math.max(1, Math.floor(opts.minFrames ?? 8));
  const sustain = Math.max(1, Math.floor(opts.sustainFrames ?? 3));

  let peakFrame = 0;
  for (let i = 1; i < n; i++) if (fractions[i] > fractions[peakFrame]) peakFrame = i;
  const peakLevel = n ? fractions[peakFrame] : 0;
  const leadingLevel = n ? medianOf(fractions.slice(0, Math.min(edge, n))) : 0;
  const trailingLevel = n ? medianOf(fractions.slice(Math.max(0, n - edge))) : 0;

  const none = (threshold: number): MaskSourceResult => ({
    kind: "none",
    frames: [],
    evidence: { leadingLevel, peakLevel, peakFrame, trailingLevel, threshold },
  });

  // 造影がそもそも見つからないランでは、同位相マスクを考える意味が無い。
  if (!(peakLevel > 0) || n < minFrames) return none(0);

  // ── 造影前があるか ────────────────────────────────────────────
  if (leadingLevel <= preRatio * peakLevel) {
    const threshold = preRatio * peakLevel;
    // 🚨 **持続して超えた所を境界にする**（単発の跳ねでは動かさない）。
    let end = n;
    for (let i = 0; i + sustain <= n; i++) {
      let all = true;
      for (let k = 0; k < sustain && all; k++) if (fractions[i + k] <= threshold) all = false;
      if (all) { end = i; break; }
    }
    const frames: number[] = [];
    for (let i = 0; i < end; i++) frames.push(i);
    if (frames.length >= minFrames) {
      return { kind: "preContrast", frames, evidence: { leadingLevel, peakLevel, peakFrame, trailingLevel, threshold } };
    }
  }

  // ── 無ければ washout した層を探す ─────────────────────────────
  if (trailingLevel <= washRatio * peakLevel) {
    const threshold = washRatio * peakLevel;
    // 🔴 **ピークより後ろだけ。** 前から遡ると造影前の立ち上がりを拾ってしまう。
    // 🚨 こちらも単発の跳ねで切らない（末尾から遡って、持続して超えた所で止める）。
    let start = peakFrame + 1;
    for (let i = n - 1; i - sustain + 1 > peakFrame; i--) {
      let all = true;
      for (let k = 0; k < sustain && all; k++) if (fractions[i - k] <= threshold) all = false;
      if (all) { start = i + 1; break; }
    }
    const frames: number[] = [];
    for (let i = start; i < n; i++) frames.push(i);
    if (frames.length >= minFrames) {
      return { kind: "washout", frames, evidence: { leadingLevel, peakLevel, peakFrame, trailingLevel, threshold } };
    }
  }

  return none(Math.min(preRatio, washRatio) * peakLevel);
}
