/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **自動同位相 DSA** の段取り（`fw/angio-design.md` §6.8・§6.9）。
 *
 * <p>DSA を ON にしたら、**造影前区間の検出 → 追尾 ROI の自動決定 → 追尾 → フレーム対応付け
 * → エッジでの残差合わせ**までを一息で行い、`dsaLoader` へフレームごとの計画を投入する。
 * 以後のフレーム送りは既存の仕組み（`optsAt()` / `maskAt()`）が自動で追従するので、
 * **ここは「計画を作るところ」だけ**。
 *
 * <h3>🔴 新しい計算は足していない</h3>
 * 使うのは全部すでにあるもの——{@link ./xaContrastOnset} と、Worker の
 * `suggest` / `match` / `alignPlan`（vitest で守られている経路）。
 * ここが持つのは**順番とメモリの都合**だけである。
 *
 * <h3>🔴 フレームは 3 回読む</h3>
 * <ol>
 *   <li><b>全画面・全フレーム</b>で「造影到達の信号」だけを作る（画素は持ち越さない）</li>
 *   <li><b>全画面・造影前だけ</b>を持って ROI を決める</li>
 *   <li><b>全フレーム</b>を、ROI の切り出しと半解像度の全画面の 2 通りで持つ</li>
 * </ol>
 * 全画面 × 全フレームを原寸で一度に持つと 1024²・150 枚で 600MB を超える（§6.7.7）。
 * 2 回目以降は Cornerstone の画像キャッシュに載っているので読み直しは安い。
 *
 * <h3>🚨 ROI の調査を間引いてはいけない</h3>
 * 運動は**時間方向の測定**なので、心拍のナイキストを割ると測れなくなる。造影前は数十枚しか
 * 無いので**間引かずに全部読む**（33 枚 × 512² × 4B ＝ 34MB・一時的）。長いランは
 * **連続した窓**で上限を掛ける（飛ばし読みはしない）。
 */
import type { DsaFramePlanEntry } from "./dsaLoader";
import type { PixelRect } from "./edgeFilters";
import type { PhaseMaskEntry } from "./xaPhaseMask";
import type { PeriodEstimate, TrackedFrame } from "./xaTracking";
import { readModalitySlice } from "./pixelCalibration";
import { yieldEvery } from "./uiYield";
import {
  contrastStartFromFractions,
  roiSurveyWindow,
  darkenedFraction,
  detectOnsetFromSignal,
  levelMatchedDifference,
  lowPercentileSignal,
  robustSpread,
} from "./xaContrastOnset";
import type {
  PackedFrames,
  TrackingAlignPlanResponse,
  TrackingAnalyzeResponse,
  TrackingMatchResponse,
  TrackingPhaseMatchResponse,
  TrackingSuggestResponse,
  XaTrackingWorkerRequest,
  XaTrackingWorkerResponse,
} from "./xaTrackingProtocol";
import { MIN_MATCHED_FRACTION, phaseMaskGates } from "./xaPhaseMaskGates";
import { classifyMaskSource, type MaskSourceResult } from "./xaPhaseMatch";
import { PHASE_DISAGREEMENT_LIMIT } from "./xaPhaseMask";

/** ROI を決めるのに読む造影前フレーム数の上限（**連続**して取る。間引かない）。 */
const ROI_SURVEY_MAX_FRAMES = 48;
/** 造影の早期検出の閾値（床の何倍か）。実測で 4σ が 1-origin 33 をはっきり当てた。 */
const CONTRAST_THRESHOLD_SIGMA = 4;
/** 追尾の探索半径 [px]。 */
const SEARCH_RADIUS = 32;
/** 振幅で絞る候補の数。 */
const MATCH_K = 3;
/** これ未満の造影前フレームしか無ければ、位相の合うマスクは期待できない。 */
const MIN_PRE_CONTRAST = 8;
/** エッジ残差の探索半径（**半解像度**・実寸 ±8px）。 */
const ALIGN_RADIUS_HALF = 4;
/**
 * 背景の突き合わせのあとに探す回転の幅 [度]（§6.17）。
 *
 * <p>§6.4 の手動ボタンは ±3° だが、こちらは**全フレームぶん回す**ので狭める。
 * ⚠️ 自由度を上げるほど「片方にしか無いもの」＝血管を変形で埋めにいく
 * （`fw/subtraction-design.md` §2.3）。効果と一緒に**回転量そのものを診断に出して**判断する。
 */
const BG_ALIGN_MAX_ROTATION_DEG = 2;
const BG_ALIGN_ROTATION_STEP_DEG = 0.5;
/**
 * 造影後でも追えるか確かめる候補の数。
 *
 * <p>🚨 **3 では足りない。** 実機（Rubo Run1）で造影後も 88% 追えた唯一の候補は **7 位**だった
 * （上位 3 つは 39% / 2% / 22%）。上位だけ見て `lostAfterContrast` に落ちていた。
 * 1 件あたり 21 フレームの読み直し（キャッシュ済み）と追尾 1 回なので、広げても安い。
 */
const VERIFY_CANDIDATES = 8;
/** 検証に使う造影後フレーム数（**ここは間引いてよい**——問うているのは時間周波数ではない）。 */
const VERIFY_FRAMES = 20;
/** 造影後にこの割合を追えない ROI は採らない。 */
const VERIFY_MIN_RELIABLE = 0.6;
/**
 * 🔴 **時間方向に埋めたフレームがこの割合を超えたら、同位相と名乗らない。**
 *
 * <p>穴を隣から埋めるのは「ラン既定のマスクへ落ちる」よりましというだけで、**そのフレームは
 * 位相が合っていない**。3 割が埋めものなら、フレームを送るたびに合っている絵と合っていない絵が
 * 混ざる——§6.8 4-D の「中途半端な計画を黙って入れない」に反する。
 */
const MAX_FILLED_FRACTION = 0.25;

/**
 * 途中経過。**段の名前と、分かるときだけ分数**を渡す。
 *
 * <p>🔴 文字列を組み立てて渡さない——画面側で i18n できなくなる（実機で
 * 「crop 12/137」という生の英語が出ていた）。
 */
export interface AutoPhaseProgress {
  step: "read" | "roi" | "verify" | "crop" | "match" | "align" | "background" | "matching";
  done?: number;
  total?: number;
}

export type AutoPhaseFailure =
  | "readFailed"
  | "noOnset"
  | "preContrastTooShort"
  | "noRoi"
  | "lostAfterContrast"
  | "noCardiacRhythm"
  | "trackFailed"
  | "tooManyFilled"
  | "noMotion"
  | "tooFewMatched"
  | "contrastPhaseFailed"
  | "noMaskFrames";

/**
 * **DSA がうまくいっているかを画面で見るための材料**（`fw/angio-design.md` §6.14）。
 *
 * <p>🔴 **成功でも失敗でも返す。** 失敗しているランでこそ中身が見たい——
 * これまで `lostAfterContrast` の当否を確かめるのに、毎回アプリの関数を手で叩いていた。
 *
 * <p>🔑 **配列は最小限**。造影の区切りは `stableFrom` / `contrastStart` の 2 つの数字から
 * 帯を引けるので、p10 の曲線も暗化画素の割合も**持たない**。
 */
export interface AutoPhaseDiagnostics {
  /** 対応付けの結果。ペアリングと**ペアリングの ZNCC**（`similarity`）はここ。 */
  entries: PhaseMaskEntry[] | null;
  /** 運動信号（px）。 */
  signal: number[] | null;
  /** フレームごとの**追尾の ZNCC**。 */
  trackScore: number[] | null;
  /** フレームごとの追尾の当否（追えなかったフレームをグラフに出すため）。 */
  reliable: boolean[] | null;
  /**
   * 🔑 **なぜ追えなかったか**（追えたフレームは null）。
   *
   * <p>以前は `reliable` の真偽だけを取り出して `reason` を捨てていた（§6.15）。
   * `lowScore` の連発（造影でテンプレートが別物になった）と `atSearchEdge` の連発
   * （探索半径が足りない）は**対処が正反対**なのに、画面から区別できなかった。
   */
  trackReason: (TrackedFrame["reason"] | null)[] | null;
  /** 位相での対応付けと振幅での対応付けが食い違ったフレーム（`true` が食い違い）。 */
  phaseDisagree: boolean[] | null;
  /** §6.16 の背景の突き合わせの結果（その経路を通ったときだけ）。 */
  backgroundEntries: TrackingPhaseMatchResponse["entries"] | null;
  /** ライブフレームごとの「造影で変わった画素」の割合。 */
  contrastFraction: number[] | null;
  /**
   * 🔑 **マスク源の判別結果と、その根拠**（§6.19）。
   * 「なぜ造影前／washout を選んだか」が読めないと、外れたときに追えない。
   */
  maskSource: MaskSourceResult | null;
  /**
   * マスク側の周期推定（**bpm の出どころそのもの**）。
   *
   * <p>🔑 実機の 45 bpm（真値 90.2）を追うには、`bpm` という 1 つの数ではなく
   * 自己相関のピークと半分の遅れが要る。`confidence` ではオクターブ誤りを弾けない（§6.15）。
   */
  maskPeriod: PeriodEstimate | null;
  /** 露出が安定したとみなしたフレーム（帯の境界）。 */
  stableFrom: number;
  /**
   * ROI 候補の採点に使った窓（枚数と長さ [ms]）。
   *
   * <p>🔑 **候補表の bpm が「—」である理由がここから読める。** 心拍の判定には 3 周期ぶん
   * （4.5 秒）要るので、1 秒強の造影前窓では原理的に出ない（§6.12.1）。
   * 窓の長さはデトレンドの方式（3 秒未満なら線形）も決める（§6.15）。
   */
  surveyFrames: number;
  surveySpanMs: number;
  /**
   * ROI 候補（採点順）。`postFraction` は**試した候補にだけ**入る——
   * 検証は合格した時点で打ち切るので、それ以降は**測っていない**（null）。
   */
  candidates: {
    rect: PixelRect;
    tileSize: number;
    score: number;
    motionPx: number;
    bpm: number | null;
    trackedFrames: number;
    totalFrames: number;
    postFraction: number | null;
    adopted: boolean;
  }[];
}

export interface AutoPhaseResult {
  ok: boolean;
  reason?: AutoPhaseFailure;
  /**
   * 🔑 **どちらの経路で同位相マスクを作ったか**（§6.16）。
   *
   * <p>`"tracking"` = 背景 ROI を全区間で追尾して振幅で並べた（従来）。
   * `"background"` = 造影で変わった画素を外して**背景を直接突き合わせた**
   * ——造影後に追尾が死ぬラン（実機の Rubo Run 1）はこちらに落ちる。
   */
  method?: "tracking" | "background";
  /** `"background"` のとき、突き合わせの ZNCC の中央値。 */
  backgroundScore?: number;
  /** `"background"` のとき、造影で外した画素の割合の中央値。 */
  contrastFraction?: number;
  /** 残差合わせで求めた回転の絶対値の中央値 [度]（§6.17）。 */
  alignRotationDeg?: number;
  /**
   * `dsaLoader.setDsaFramePlan()` へそのまま渡せる計画。
   * 🔴 **失敗時にも返る**——造影前フレームを自分自身に当てる分（`selfPlan`）は、
   * 位相合わせの成否と関係なく正しいからである（§6.10 3-B）。
   */
  plan?: (DsaFramePlanEntry | null)[];
  /** 採用した追尾 ROI（画面に出して差し替えられるようにするため）。 */
  roi?: PixelRect;
  onset?: number;
  /** 暗化画素の割合で絞り込んだ「造影が本当に始まるフレーム」（0 origin）。 */
  contrastStart?: number;
  /** 造影前フレーム（**失敗時も返す**。既定マスクをここへ差し替えるため・§5-D）。 */
  preContrast?: number[];
  preContrastCount?: number;
  /** 画像由来の心拍。出せなければ null。 */
  bpm?: number | null;
  matchedFrames?: number;
  totalFrames?: number;
  /** 振幅の端へ丸めて当てた（外挿した）フレーム数。 */
  clampedFrames?: number;
  /** 穴を時間方向の隣から埋めたフレーム数。 */
  filledFrames?: number;
  /** エッジ残差が求まったフレーム数。 */
  alignedFrames?: number;
  /** マスク側の運動振幅 [px]（p10–p90）。 */
  amplitudeSpanPx?: number;
  /** 位置のずれの中央値 [px]。 */
  medianAmplitudeDiff?: number;
  /** 画面で見るための材料。**成功でも失敗でも入る**（段が進むほど埋まる）。 */
  diagnostics?: AutoPhaseDiagnostics;
}

/* ------------------------------------------------------------------ */
/* Worker（使い回す）                                                   */
/* ------------------------------------------------------------------ */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, {
  resolve: (r: XaTrackingWorkerResponse) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number) => void;
}>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./xaTrackingWorker.ts", import.meta.url), { type: "module" });
  w.onmessage = (ev: MessageEvent<XaTrackingWorkerResponse>) => {
    const p = pending.get(ev.data.requestId);
    if (!p) return;
    // 🔴 **途中経過では解決しない。** 消してしまうと本来の応答が迷子になる。
    if (ev.data.type === "progress") { p.onProgress?.(ev.data.done, ev.data.total); return; }
    pending.delete(ev.data.requestId);
    if (ev.data.type === "error") p.reject(new Error(ev.data.message));
    else p.resolve(ev.data);
  };
  w.onerror = () => {
    for (const p of pending.values()) p.reject(new Error("xaTrackingWorker failed"));
    pending.clear();
  };
  worker = w;
  return w;
}

/** セッションを畳むときに呼ぶ（シリーズ切替・DSA OFF）。 */
export function releaseAutoPhaseWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}

type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never;

function ask(
  req: WithoutId<XaTrackingWorkerRequest>,
  transfer: Transferable[] = [],
  onProgress?: (done: number, total: number) => void,
): Promise<XaTrackingWorkerResponse> {
  const w = ensureWorker();
  const requestId = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
    w.postMessage({ ...req, requestId } as XaTrackingWorkerRequest, transfer);
  });
}

/* ------------------------------------------------------------------ */

/** 造影前区間が決まった時点で呼び出し側へ渡すもの。 */
export interface PreContrastInfo {
  /** マスク候補にしてよいフレーム（0 origin）。 */
  preContrast: number[];
  /** 造影が始まるフレーム（0 origin）。 */
  contrastStart: number;
  /**
   * `t < contrastStart` を**自分自身**に当てる計画（それ以外は null ＝ 既定マスクへ）。
   * 🔴 絞り込めていないとき（粗い onset のまま降りるとき）は **null**。
   * 粗い onset は実測で **9 フレーム遅い**ので、そのまま自己マスクにすると
   * 造影の立ち上がりを隠してしまう。
   */
  selfPlan: (DsaFramePlanEntry | null)[] | null;
}

export interface AutoPhaseParams {
  /** ネイティブフレームの imageId（t 昇順）。**DSA 合成ではない**。 */
  frameIds: readonly string[];
  /** 各フレームの開始時刻 [ms]（`xaCineTiming.frameStartTimesMs()`）。 */
  frameStartTimesMs: readonly number[];
  /** `PixelIntensityRelationship = LIN` なら true。 */
  logarithmic: boolean;
  onProgress?: (p: AutoPhaseProgress) => void;
  /**
   * 造影前区間が決まった時点で呼ぶ（追尾より**ずっと早い**）。
   * 🔴 呼び出し側はここで既定マスクを造影前へ差し替え、`selfPlan` があればそのまま入れること。
   * 計画が作れなかったときの落ち先が露出ランプのままだと、**そのフレームだけ明るい**という
   * 実機の不具合がそのまま残る。
   */
  onPreContrast?: (info: PreContrastInfo) => void;
  /** 途中で中止する（シリーズ切替・DSA OFF）。 */
  isCancelled?: () => boolean;
}


/** ROI の周り（探索半径＋余白）を切り出す矩形。検証でも本番でも同じ規則を使う。 */
function cropRectFor(roi: PixelRect, width: number, height: number): PixelRect {
  const margin = SEARCH_RADIUS + 8;
  return {
    x0: Math.max(0, roi.x0 - margin),
    y0: Math.max(0, roi.y0 - margin),
    x1: Math.min(width - 1, roi.x1 + margin),
    y1: Math.min(height - 1, roi.y1 + margin),
  };
}

/** 全画面座標の矩形を、切り出し座標系へ移す。 */
function shiftRect(r: PixelRect, crop: PixelRect): PixelRect {
  return { x0: r.x0 - crop.x0, y0: r.y0 - crop.y0, x1: r.x1 - crop.x0, y1: r.y1 - crop.y0 };
}

/** 指定したフレームだけを切り出して 1 本に詰める。 */
async function readCrop(
  frameIds: readonly string[],
  frames: readonly number[],
  crop: PixelRect,
  params: AutoPhaseParams,
): Promise<{ frames: PackedFrames } | null> {
  const cw = crop.x1 - crop.x0 + 1;
  const ch = crop.y1 - crop.y0 + 1;
  const values = new Float32Array(cw * ch * frames.length);
  for (let k = 0; k < frames.length; k++) {
    if (params.isCancelled?.()) return null;
    const s = await readModalitySlice(frameIds[frames[k]]);
    if (!s) return null;
    const base = k * cw * ch;
    for (let y = 0; y < ch; y++) {
      const src = (crop.y0 + y) * s.width + crop.x0;
      values.set(s.values.subarray(src, src + cw), base + y * cw);
    }
  }
  return { frames: { values, frameCount: frames.length, width: cw, height: ch } };
}

/** 2 倍ダウンサンプル（2×2 の平均）。エッジ残差合わせに送るため。 */
function halveFrame(src: Float32Array, width: number, height: number, out: Float32Array, at: number): void {
  const hw = width >> 1;
  const hh = height >> 1;
  for (let y = 0; y < hh; y++) {
    const r0 = (y * 2) * width;
    const r1 = r0 + width;
    const dst = at + y * hw;
    for (let x = 0; x < hw; x++) {
      const c = x * 2;
      out[dst + x] = (src[r0 + c] + src[r0 + c + 1] + src[r1 + c] + src[r1 + c + 1]) / 4;
    }
  }
}

/**
 * 自動同位相マスクの計画を作る。**失敗は必ず理由つきで返す**（例外にしない）。
 *
 * <p>🔴 **中途半端な計画を返さない。** 一部のフレームだけ同位相になると、フレームを送るたびに
 * 絵の性質が変わり、いちばん読み取りにくい壊れ方になる。対応が付いたフレームが半数を割ったら
 * 失敗として扱い、呼び出し側は造影前フレームの平均マスクのままにする。
 */
export async function buildAutoPhaseMaskPlan(params: AutoPhaseParams): Promise<AutoPhaseResult> {
  const { frameIds, frameStartTimesMs, logarithmic } = params;
  const n = frameIds.length;
  const cancelled = () => params.isCancelled?.() ?? false;

  // 🔴 **段が進むほど埋まる器。** どの `fail()` でもこれを付けて返すので、
  //    途中で降りても「そこまでに分かったこと」は画面に出る。
  const diag: AutoPhaseDiagnostics = {
    entries: null, signal: null, trackScore: null, reliable: null, trackReason: null,
    phaseDisagree: null, backgroundEntries: null, contrastFraction: null, maskSource: null,
    maskPeriod: null, stableFrom: 0, surveyFrames: 0, surveySpanMs: 0, candidates: [],
  };
  const fail = (reason: AutoPhaseFailure, extra: Partial<AutoPhaseResult> = {}): AutoPhaseResult =>
    ({ ok: false, reason, totalFrames: n, diagnostics: diag, ...extra });
  if (n < 8) return fail("readFailed");

  // ── 1 回目: 造影到達の信号だけを作る（画素は持ち越さない） ────────────
  let width = 0;
  let height = 0;
  const signal: number[] = [];
  for (let t = 0; t < n; t++) {
    if (cancelled()) return fail("readFailed");
    params.onProgress?.({ step: "read", done: t + 1, total: n });
    await yieldEvery(t);
    const s = await readModalitySlice(frameIds[t]);
    if (!s) return fail("readFailed");
    if (!width) { width = s.width; height = s.height; }
    if (s.width !== width || s.height !== height) return fail("readFailed");
    signal.push(lowPercentileSignal([s.values], width, height)[0]);
  }
  if (!width) return fail("readFailed");

  const onsetResult = detectOnsetFromSignal(signal, frameStartTimesMs);
  if (onsetResult.onset == null) return fail("noOnset");
  const onset = onsetResult.onset;
  diag.stableFrom = onsetResult.stableFrom;
  const roughPre = onsetResult.preContrast;
  if (roughPre.length < MIN_PRE_CONTRAST) {
    // ═══ §6.19 — 造影前が足りない。判別してから washout 層へ落ちる ═══
    //
    // 🚨 **ここで「造影前が無い」と決めつけない。** `detectOnsetFromSignal` は
    //    「ランが造影前から始まる」前提の検出器なので、最初から造影が入っているランでは
    //    出力そのものが当てにならない。**造影量の時系列を測り直して判別する。**
    // 🔴 絞り込めていないので `selfPlan` は渡さない（粗い onset は実測で 9 フレーム遅い）。
    params.onPreContrast?.({ preContrast: [...roughPre], contrastStart: onset, selfPlan: null });
    const shortCommon = { onset, preContrast: roughPre, preContrastCount: roughPre.length };

    params.onProgress?.({ step: "background" });
    const read = await readHalfFrames(frameIds, width, height, cancelled, params.onProgress);
    if (!read) return fail("readFailed", shortCommon);

    let profile: XaTrackingWorkerResponse;
    try {
      profile = await ask({
        type: "contrastProfile",
        frames: { values: read.half, frameCount: n, width: read.bw, height: read.bh },
        logarithmic,
      });
    } catch {
      return fail("preContrastTooShort", shortCommon);
    }
    if (profile.type !== "contrastProfileDone") return fail("preContrastTooShort", shortCommon);

    const source = classifyMaskSource(profile.fractions, { minFrames: MIN_PRE_CONTRAST });
    diag.contrastFraction = profile.fractions;
    diag.maskSource = source;

    // 🔴 **判別が `preContrast` を指したのに、ここへ来た。** 検出器と判別が食い違って
    //    いるので、無理に進めず正直に降りる（どちらが正しいかは診断の数値で追える）。
    if (source.kind !== "washout") {
      return fail(source.kind === "none" ? "noMaskFrames" : "preContrastTooShort", {
        ...shortCommon, diagnostics: diag,
      });
    }

    // 🔴 **washout 層は自己差分に使えない。** 血管が残っているので「誤差ちょうど 0」に
    //    ならない。自己差分の計画は空（`selfUntil = 0`）。
    const emptySelf: (DsaFramePlanEntry | null)[] = Array.from({ length: n }, () => null);
    const maskSet = new Set(source.frames);
    const live: number[] = [];
    for (let t = 0; t < n; t++) if (!maskSet.has(t)) live.push(t);

    return runBackgroundMatch({
      frameIds, n, width, height, logarithmic, half: read.half,
      maskFrames: [...source.frames],
      liveFrames: live,
      selfPlan: emptySelf,
      selfUntil: 0,
      diag,
      common: { ...shortCommon, contrastStart: source.frames[0] },
      cancelled,
      ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });
  }

  // ── 2 回目: 粗い造影前区間を**全画面・間引かずに**読む ─────────────────
  // 🔑 この 1 パスで 3 つ片付ける: ①造影前の平均 ②造影が本当に始まるフレーム
  //    ③ROI 調査用の画素。読み直しは増やさない（§6.10 3-C）。
  if (cancelled()) return fail("readFailed");
  params.onProgress?.({ step: "roi" });
  // 上限を超えるときは **onset 側に寄せた連続した窓**を取る（飛ばし読みはしない）。
  // 造影が始まるのは onset の近くなので、そちら側が要る。
  // 🔴 造影開始がまだ決まっていないので、ここでは窓だけ取る（接頭辞は下で
  //    `roiSurveyWindow` に決めさせる）。
  const window = roiSurveyWindow(roughPre, Number.POSITIVE_INFINITY, ROI_SURVEY_MAX_FRAMES).window;
  const frameSize = width * height;
  const survey = new Float32Array(frameSize * window.length);
  const sum = new Float64Array(frameSize);
  for (let k = 0; k < window.length; k++) {
    if (cancelled()) return fail("readFailed");
    const s = await readModalitySlice(frameIds[window[k]]);
    if (!s) return fail("readFailed");
    survey.set(s.values, k * frameSize);
    for (let i = 0; i < frameSize; i++) sum[i] += s.values[i];
  }
  const roughMask = Float32Array.from(sum, (v) => v / window.length);

  // ── 造影が「本当に」始まるフレームを絞り込む ──────────────────────────
  // 🚨 p10 の持続低下で出る onset は、冠動脈では**遅れる**（血管は画面の 1% しか占めない）。
  //    マスクとの差で「はっきり暗い画素の割合」を見ると、ずっと早く立ち上がる。
  const fractions: number[] = [];
  let spread = 0;
  {
    const diffs: Float64Array[] = [];
    for (let k = 0; k < window.length; k++) {
      diffs.push(levelMatchedDifference(
        roughMask, survey.subarray(k * frameSize, (k + 1) * frameSize), logarithmic,
      ));
    }
    // 床は**前半の造影前フレーム**で自己較正する（素材で決まるので定数にしない）。
    const half = Math.max(1, window.length >> 1);
    const spreads = diffs.slice(0, half).map(robustSpread).sort((a, b) => a - b);
    spread = spreads[spreads.length >> 1] ?? 0;
    const threshold = CONTRAST_THRESHOLD_SIGMA * spread;
    for (let k = 0; k < window.length; k++) fractions[window[k]] = darkenedFraction(diffs[k], threshold);
  }
  const contrastStart = spread > 0
    ? contrastStartFromFractions(fractions, window[0], window[window.length - 1])
    : onset;

  const preContrast = roughPre.filter((t) => t < contrastStart);
  // 🔴 造影前フレームは**自分自身**を引く。誤差ゼロで、位相合わせの成否に依らない。
  const selfPlan: (DsaFramePlanEntry | null)[] = Array.from({ length: n }, (_, t) =>
    t < contrastStart && frameIds[t]
      ? { maskImageIds: [frameIds[t]], maskFrames: [t], dx: 0, dy: 0 }
      : null);
  params.onPreContrast?.({ preContrast: [...preContrast], contrastStart, selfPlan });

  if (preContrast.length < MIN_PRE_CONTRAST) {
    return fail("preContrastTooShort", {
      onset, contrastStart, preContrast, preContrastCount: preContrast.length, plan: selfPlan,
    });
  }

  // ROI の調査は**造影が混ざっていないフレームだけ**で行う。
  // 🔴 **枚数と時刻を別々の式から作らない。** `surveyFrames` を唯一の真実にして、
  //    画素も時刻もここから派生させる（§6.15。以前は時刻だけ `window` の長さになり、
  //    `suggestTrackingRois` が長さ不一致で黙って時刻を捨てていた）。
  const { surveyFrames } = roiSurveyWindow(roughPre, contrastStart, ROI_SURVEY_MAX_FRAMES);
  const surveyCount = surveyFrames.length;
  diag.surveyFrames = surveyCount;
  diag.surveySpanMs = surveyCount >= 2
    ? (frameStartTimesMs[surveyFrames[surveyCount - 1]] ?? 0) - (frameStartTimesMs[surveyFrames[0]] ?? 0)
    : 0;
  if (surveyCount < 4) return fail("noRoi", { onset, contrastStart, preContrast, plan: selfPlan });
  const surveyPacked: PackedFrames = { values: survey.subarray(0, frameSize * surveyCount), frameCount: surveyCount, width, height };
  const tile = Math.max(32, Math.min(96, Math.round(Math.min(width, height) / 8)));
  let suggest: TrackingSuggestResponse;
  try {
    const res = await ask(
      {
        type: "suggest",
        frames: surveyPacked,
        referenceIndex: surveyCount >> 1,
        logarithmic,
        tileSize: tile,
        // 🔴 大きさひとつでは見つからない（実機では 48px でのみ見つかった）。
        tileSizes: [tile, Math.max(24, Math.round(tile * 0.75))],
        // 🚨 心拍帯で採点させる（呼吸で動く横隔膜を 1 位にしないため・§6.11）。
        //    🔴 **画素と同じ `surveyFrames` から作る**（長さが違うと受け側が弾く）。
        frameStartTimesMs: surveyFrames.map((t) => frameStartTimesMs[t] ?? t * 40),
        maxCandidates: VERIFY_CANDIDATES,
      },
      // 🔴 transfer しない。`survey` は `subarray` の親なので、渡すと元も使えなくなる。
    );
    if (res.type !== "suggestDone") return fail("noRoi", { onset, contrastStart, preContrast, plan: selfPlan });
    suggest = res;
  } catch {
    return fail("noRoi", { onset, contrastStart, preContrast, plan: selfPlan });
  }
  diag.candidates = suggest.candidates.map((c) => ({
    rect: c.rect, tileSize: c.tileSize, score: c.score, motionPx: c.motionPx, bpm: c.bpm,
    trackedFrames: c.trackedFrames, totalFrames: c.totalFrames,
    postFraction: null, adopted: false,
  }));
  const usable = suggest.candidates.filter((c) => c.score > 0).slice(0, VERIFY_CANDIDATES);
  if (!usable.length) {
    return fail("noRoi", { onset, contrastStart, preContrast, preContrastCount: preContrast.length, plan: selfPlan });
  }

  // ── 候補を**造影後でも追えるか**で選び直す ──────────────────────────
  // 🚨 ROI の順位は造影前区間だけで付けている（運動はそこでしか測れない）。ところが
  //    いちばんよく動く場所は**心陰影の縁＝造影剤が流れ込む場所**でもある。実機で、
  //    造影前では 11.4px 動く優秀なタイル (216,264) が、全 137 フレームでは
  //    **104 フレームが lowScore** になった（造影でテンプレートが別物になる）。
  //    §3.5 の `contrastChange` はこれを防ぐためのものだったが、造影前だけを見ていては
  //    測れない。だから**採用する前に造影後で試す**。
  // 🔑 ここは**間引いてよい**。問うているのは「テンプレートがまだ合うか」という
  //    フレームごとの性質であって、時間周波数ではない。
  const refFrame = preContrast[preContrast.length >> 1];
  const postStep = Math.max(1, Math.floor((n - contrastStart) / VERIFY_FRAMES));
  const postIdx: number[] = [];
  for (let t = contrastStart; t < n && postIdx.length < VERIFY_FRAMES; t += postStep) postIdx.push(t);

  let chosen: { rect: PixelRect; fraction: number } | null = null;
  if (postIdx.length >= 4) {
    for (const cand of usable) {
      if (cancelled()) return fail("readFailed", { onset, contrastStart, preContrast, plan: selfPlan });
      params.onProgress?.({ step: "verify" });
      const c = cropRectFor(cand.rect, width, height);
      const pack = await readCrop(frameIds, [refFrame, ...postIdx], c, params);
      if (!pack) return fail("readFailed", { onset, contrastStart, preContrast, plan: selfPlan });
      let res: XaTrackingWorkerResponse;
      try {
        res = await ask(
          {
            type: "analyze",
            frames: pack.frames,
            originX: c.x0,
            originY: c.y0,
            roi: shiftRect(cand.rect, c),
            referenceFrame: 0, // 先頭に造影前の参照フレームを入れてある
            logarithmic,
            searchRadius: SEARCH_RADIUS,
            frameStartTimesMs: [refFrame, ...postIdx].map((t) => frameStartTimesMs[t] ?? t * 40),
          },
          [pack.frames.values.buffer],
        );
      } catch {
        continue;
      }
      if (res.type !== "analyzeDone") continue;
      const done = res as TrackingAnalyzeResponse;
      const post = done.frames.slice(1);
      const fraction = post.length ? post.filter((f) => f.reliable).length / post.length : 0;
      const slot = diag.candidates.find((d) => d.rect === cand.rect);
      if (slot) slot.postFraction = fraction;
      if (!chosen || fraction > chosen.fraction) chosen = { rect: cand.rect, fraction };
      if (fraction >= VERIFY_MIN_RELIABLE) break;
    }
  } else {
    chosen = { rect: usable[0].rect, fraction: 1 };
  }
  if (!chosen) {
    return fail("noRoi", { onset, contrastStart, preContrast, preContrastCount: preContrast.length, plan: selfPlan });
  }
/** {@link runBackgroundMatch} への入力。 */
interface BackgroundMatchArgs {
  frameIds: readonly string[];
  n: number;
  width: number;
  height: number;
  logarithmic: boolean;
  /** マスクにしてよいフレーム（**造影前**または **washout 層**）。 */
  maskFrames: number[];
  /** マスクを当てたいフレーム。 */
  liveFrames: number[];
  /** 自己差分の計画（造影前が無いランでは全部 null）。 */
  selfPlan: (DsaFramePlanEntry | null)[];
  /**
   * 自己差分が正しい境界。**造影前が無いランでは 0**。
   * 🔴 washout 層は自己差分に使えない——血管が残っているので「誤差ちょうど 0」にならない。
   */
  selfUntil: number;
  diag: AutoPhaseDiagnostics;
  /** 失敗時にも載せる文脈（roi / onset / contrastStart など）。 */
  common: Partial<AutoPhaseResult>;
  cancelled: () => boolean;
  onProgress?: (p: AutoPhaseProgress) => void;
  /** **2 倍ダウンサンプルした全画面**の全フレーム（{@link readHalfFrames} が作る）。 */
  half: Float32Array;
}

/**
 * 全フレームを**半解像度**で読む。
 *
 * <p>🔑 判別（造影量の時系列）と突き合わせと残差合わせが**同じ画素を使う**ので、
 * 読むのは 1 回だけにする。137 枚を読み直すと目に見えて待たされる。
 */
async function readHalfFrames(
  frameIds: readonly string[],
  width: number,
  height: number,
  cancelled: () => boolean,
  onProgress?: (p: AutoPhaseProgress) => void,
): Promise<{ half: Float32Array; bw: number; bh: number } | null> {
  const n = frameIds.length;
  const bw = width >> 1;
  const bh = height >> 1;
  const half = new Float32Array(bw * bh * n);
  for (let t = 0; t < n; t++) {
    if (cancelled()) return null;
    onProgress?.({ step: "background", done: t + 1, total: n });
    await yieldEvery(t);
    const sl = await readModalitySlice(frameIds[t]);
    if (!sl) return null;
    halveFrame(sl.values, width, height, half, t * bw * bh);
  }
  return { half, bw, bh };
}

/**
 * **背景の突き合わせで同位相マスクを作る**（§6.16）。
 *
 * <p>🔑 マスク源が造影前でも washout 層でも**同じ処理**である。違うのは
 * 「どのフレームをマスクにしてよいか」だけなので、引数で受ける（§6.19）。
 */
async function runBackgroundMatch(a: BackgroundMatchArgs): Promise<AutoPhaseResult> {
  // ═══ §6.16 — 背景の突き合わせへ切り替える ═══════════════════════
  //
  // 🔑 追尾が造影で死ぬのは「**追う対象を選ぶ**」ことの帰結だった（§6.11.4）。
  //    心拍をよく運ぶ ROI は造影で壊れ、造影に強い ROI は心拍を持たない。
  //    **選ぶのをやめれば矛盾しない**——ライブフレームごとに、造影で変わった画素を
  //    外して背景がいちばん似た造影前フレームを当てればよい。
  //
  // 🔴 ここは**降りる先の格上げ**である。従来はこのまま `lostAfterContrast` で降り、
  //    造影後は「造影前の平均マスク 1 枚」になっていた（実機の Rubo Run 1 がそこにいた）。
  const {
    frameIds, n, width, height, logarithmic,
    maskFrames, liveFrames, selfPlan, selfUntil, diag, common, cancelled, onProgress,
  } = a;
  const lost = { ...common, plan: selfPlan, diagnostics: diag, totalFrames: n };
  const failBg = (reason: AutoPhaseFailure, extra: Partial<AutoPhaseResult> = {}): AutoPhaseResult =>
    ({ ok: false, reason, ...lost, ...extra });
  const bw = width >> 1;
  const bh = height >> 1;
  const bgHalf = a.half;
  
  let pmRes: XaTrackingWorkerResponse;
  try {
    pmRes = await ask(
    {
      type: "phaseMatch",
      // 🔴 **transfer しない。** このあとの残差合わせ（alignPlan）で同じ画素を使う。
      //    渡してしまうと読み直しになる（137 枚ぶん）。
      frames: { values: bgHalf, frameCount: n, width: bw, height: bh },
      maskFrames: [...maskFrames],
      liveFrames: [...liveFrames],
      logarithmic,
    },
    [],
    (done, total) => onProgress?.({ step: "matching", done, total }),
    );
  } catch {
    return failBg("contrastPhaseFailed");
  }
  if (pmRes.type !== "phaseMatchDone") return failBg("contrastPhaseFailed");
  const pm = pmRes;

  diag.backgroundEntries = pm.entries;
  diag.contrastFraction = pm.contrastFraction;
  // 🔴 **出自の分類は `diag.entries` を見る**（`xaDsaPlot.maskOrigin`）。ここを埋めないと、
  //    突き合わせで当たったフレームまで「穴埋め」に分類される——実機で
  //    「filled 105 / phase 0」と出て、効いているのかどうか画面から読めなかった。
  //    同じ器に詰め直すことで、①の色も③の pair ZNCC も既存のまま動く。
  diag.entries = Array.from({ length: n }, (_, t): PhaseMaskEntry => ({
    liveFrame: t,
    maskFrame: t < selfUntil ? t : null,
    dx: 0,
    dy: 0,
    amplitudeDiff: Number.NaN,
    similarity: null,
    status: t < selfUntil ? "ok" : "outOfRange",
    phaseMaskFrame: null,
    phaseDisagreement: null,
  }));
  for (const e of pm.entries) {
    const slot = diag.entries[e.liveFrame];
    if (!slot) continue;
    slot.maskFrame = e.maskFrame;
    slot.similarity = e.maskFrame != null ? e.score : null;
    slot.status = e.maskFrame != null ? "ok" : "outOfRange";
  }

  // 造影前は自分自身のまま。造影後だけ突き合わせの結果で埋める。
  // 🔴 **残差シフトは 0。** 追尾が死んでいるので取れないし、背景がいちばん合うマスクを
  //    選んだ時点で解剖は既に揃っている。足りなければ §6.4 の自動位置合わせが拾う。
  const bgPlan: (DsaFramePlanEntry | null)[] = selfPlan.map((e) => e);
  let bgMatched = 0;
  for (const e of pm.entries) {
    if (e.maskFrame == null || !frameIds[e.maskFrame]) continue;
    bgPlan[e.liveFrame] = {
    maskImageIds: [frameIds[e.maskFrame]], maskFrames: [e.maskFrame], dx: 0, dy: 0,
    };
    bgMatched++;
  }
  const bgLive = Math.max(1, liveFrames.length);
  if (bgMatched < bgLive * MIN_MATCHED_FRACTION) {
    return failBg("contrastPhaseFailed", { matchedFrames: bgMatched });
  }

  // 穴は時間方向に最も近い当たったフレームで埋める（従来経路と同じ作法）。
  let bgFilled = 0;
  for (const t of liveFrames) {
    if (bgPlan[t]) continue;
    let src: DsaFramePlanEntry | null = null;
    for (let d = 1; d < bgPlan.length && !src; d++) src = bgPlan[t - d] ?? bgPlan[t + d] ?? null;
    if (!src) continue;
    bgPlan[t] = { maskImageIds: [...src.maskImageIds], maskFrames: [...src.maskFrames], dx: 0, dy: 0 };
    bgFilled++;
  }

  // ── 画像全体の剛体位置合わせ（§6.17）────────────────────────────
  // 🔑 突き合わせは「背景がいちばん合うマスク」を選ぶが、**選んだうえで残る**ずれがある。
  //    ここは ROI ではなく**画像全体**で合わせる（`alignOnEdges` の既定が画像全体）。
  // 🔴 基準のずらしは 0——マスクを選んだ時点で解剖は揃っている前提なので、**残差だけ**を探す。
  let bgAligned = 0;
  let bgRotations: number[] = [];
  if (!cancelled()) {
    onProgress?.({ step: "align" });
    try {
    const ar = await ask(
      {
        type: "alignPlan",
        frames: { values: bgHalf, frameCount: n, width: bw, height: bh },
        // 🔑 造影前は自分自身なので残差は定義上 0。計算させない。
        maskFrameFor: bgPlan.map((e, t) => (t < selfUntil ? null : e?.maskFrames[0] ?? null)),
        baseDx: bgPlan.map(() => 0),
        baseDy: bgPlan.map(() => 0),
        logarithmic,
        searchRadius: ALIGN_RADIUS_HALF,
        maxRotationDeg: BG_ALIGN_MAX_ROTATION_DEG,
        rotationStepDeg: BG_ALIGN_ROTATION_STEP_DEG,
      },
      [bgHalf.buffer],
      (done, total) => onProgress?.({ step: "align", done, total }),
    );
    if (ar.type === "alignPlanDone") {
      bgAligned = ar.aligned;
      for (let t = 0; t < bgPlan.length; t++) {
        const a = ar.align[t];
        const e = bgPlan[t];
        if (!e || !a) continue;
        e.alignDx = a.dx;
        e.alignDy = a.dy;
        if (a.rotationDeg) e.alignRotationDeg = a.rotationDeg;
        bgRotations.push(a.rotationDeg);
      }
    }
    } catch {
    // 🔴 **残差が出なくても計画そのものは使える。** 黙って計画ごと捨てない。
    bgAligned = 0;
    }
  }
  bgRotations = bgRotations.map(Math.abs).sort((a, b) => a - b);

  const scores = pm.entries.filter((e) => e.maskFrame != null).map((e) => e.score).sort((a, b) => a - b);
  const fracs = [...pm.contrastFraction].sort((a, b) => a - b);
  return {
    ...lost,
    ok: true,
    plan: bgPlan,
    method: "background",
    matchedFrames: bgMatched,
    filledFrames: bgFilled,
    alignedFrames: bgAligned,
    backgroundScore: scores.length ? scores[scores.length >> 1] : 0,
    contrastFraction: fracs.length ? fracs[fracs.length >> 1] : 0,
    // 🔑 **回転量そのものを出す。** 心臓の回旋なら 1° 未満のはず。数度出るなら
    //    「片方にしか無いもの（血管）を変形で埋めにいっている」疑いが立つ（§6.17）。
    alignRotationDeg: bgRotations.length ? bgRotations[bgRotations.length >> 1] : 0,
  };
}

  if (chosen.fraction < VERIFY_MIN_RELIABLE) {
    params.onProgress?.({ step: "background" });
    const read = await readHalfFrames(frameIds, width, height, cancelled, params.onProgress);
    if (!read) {
      return fail("readFailed", {
        roi: chosen.rect, onset, contrastStart, preContrast, plan: selfPlan,
      });
    }
    return runBackgroundMatch({
      frameIds, n, width, height, logarithmic, half: read.half,
      maskFrames: [...preContrast],
      liveFrames: Array.from({ length: n - contrastStart }, (_, i) => contrastStart + i),
      selfPlan,
      selfUntil: contrastStart,
      diag,
      common: {
        roi: chosen.rect, onset, contrastStart, preContrast,
        preContrastCount: preContrast.length,
      },
      cancelled,
      ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });
  }
  const roi = chosen.rect;
  for (const d of diag.candidates) d.adopted = d.rect === roi;

  // ── 3 回目: ROI の切り出しと、半解像度の全画面を同時に作る ────────────
  const crop = cropRectFor(roi, width, height);
  const cw = crop.x1 - crop.x0 + 1;
  const ch = crop.y1 - crop.y0 + 1;
  const cropped = new Float32Array(cw * ch * n);
  const hw = width >> 1;
  const hh = height >> 1;
  const half = new Float32Array(hw * hh * n);
  for (let t = 0; t < n; t++) {
    if (cancelled()) return fail("readFailed", { onset, contrastStart, preContrast, plan: selfPlan });
    params.onProgress?.({ step: "crop", done: t + 1, total: n });
    await yieldEvery(t);
    const s = await readModalitySlice(frameIds[t]);
    if (!s) return fail("readFailed", { onset, contrastStart, preContrast, plan: selfPlan });
    const base = t * cw * ch;
    for (let y = 0; y < ch; y++) {
      const src = (crop.y0 + y) * width + crop.x0;
      cropped.set(s.values.subarray(src, src + cw), base + y * cw);
    }
    halveFrame(s.values, width, height, half, t * hw * hh);
  }

  // ── 追尾＋対応付け（Worker・同一ラン内） ────────────────────────────
  if (cancelled()) return fail("readFailed", { onset, contrastStart, preContrast, plan: selfPlan });
  params.onProgress?.({ step: "match" });
  let match: TrackingMatchResponse;
  try {
    const res = await ask(
      {
        type: "match",
        live: { values: cropped, frameCount: n, width: cw, height: ch },
        mask: null, // 同一ラン内
        roi: shiftRect(roi, crop),
        liveReference: preContrast[preContrast.length >> 1],
        maskReference: preContrast[preContrast.length >> 1],
        logarithmic,
        searchRadius: SEARCH_RADIUS,
        liveTimesMs: [...frameStartTimesMs],
        maskTimesMs: [...frameStartTimesMs],
        usableMaskFrames: preContrast,
        k: MATCH_K,
        // 🔴 自動経路だけ外挿を認める。落ち先（ラン既定のマスク）のほうがはるかに悪いため。
        clampOutOfRange: true,
        // 🔑 造影前フレームは**自分自身を候補に入れる**。答えは決め打たず ZNCC に選ばせる
        //    （自己相関 1.0 は絶対最大なので必ず勝つ）。§6.11。
        selfMaskFrames: Array.from({ length: contrastStart }, (_, t) => t),
      },
      [cropped.buffer],
    );
    if (res.type !== "matchDone") return fail("trackFailed", { onset, contrastStart, preContrast, plan: selfPlan });
    match = res;
  } catch {
    return fail("trackFailed", { onset, contrastStart, preContrast, plan: selfPlan });
  }

  diag.entries = match.entries;
  diag.signal = Array.from(match.liveSignal);
  diag.trackScore = match.liveFrames.map((f) => f.score);
  diag.reliable = match.liveFrames.map((f) => f.reliable);
  // 🔴 **理由を捨てない（§6.15）。** 対処が正反対の故障を区別できるようにする。
  diag.trackReason = match.liveFrames.map((f) => f.reason ?? null);
  diag.maskPeriod = match.maskPeriod;
  diag.phaseDisagree = match.entries.map(
    (e) => e.phaseDisagreement != null && e.phaseDisagreement > PHASE_DISAGREEMENT_LIMIT,
  );

  const common = {
    roi, onset, contrastStart, preContrast, preContrastCount: preContrast.length, totalFrames: n,
    // 🔴 どの門で降りても**自己マスクは残す**（造影前は位相合わせと無関係に正しい）。
    plan: selfPlan,
  };
  // 🚨 **心拍かどうかの判定はここで行う。** ROI の採点の段（造影前だけ＝実機で 1.4 拍）では
  //    窓が短すぎて周期が出せない。ここは全フレームを追尾しているので自己相関が効く
  //    （実測で同じタイルが 88〜90 bpm・DICOM の R 波タグ 90.2 と一致）。
  // 🔴 門そのものは `xaPhaseMaskGates.ts` に置いてある——**手動経路（診断ダイアログ）と
  //    同じ判定を使うため**（§6.15。以前はここにしか無く、手動は素通りしていた）。
  const gates = phaseMaskGates({
    liveTracked: match.liveTracked,
    totalFrames: n,
    maskAmplitudeSpan: match.maskAmplitudeSpan,
    periodConfidence: match.maskPeriod.confidence,
  });
  if (gates.length) {
    return fail(gates[0], { ...common, amplitudeSpanPx: match.maskAmplitudeSpan });
  }

  const matched = match.entries.filter((e, t) => t >= contrastStart && e.maskFrame != null).length;
  // 🔴 **confidence が "ok" のときだけ bpm を出す。** 自信が無いなら黙る。
  //
  // ⚠️ **この門はオクターブ誤りを弾かない（§6.15 で判明）。** `confidence` は自己相関の
  //    ピークの高さで、オクターブ誤りは `r(2T) ≈ r(T)` ＝**両方高い**ときに起きるので、
  //    倍周期にロックしても "ok" のまま通る。実機の 45 bpm（真値 90.2）はこれで、
  //    **まだ直っていない**。判断材料（`octaveHalved` / `halfLagCorrelation` /
  //    `peakCorrelation`）を診断ダイアログに出して、次はそこから追う。
  const bpm = match.maskPeriod.confidence === "ok" && match.maskPeriod.periodMs > 0
    ? 60000 / match.maskPeriod.periodMs
    : null;
  if (matched < (n - contrastStart) * MIN_MATCHED_FRACTION) {
    return fail("tooFewMatched", {
      ...common, bpm, matchedFrames: matched, amplitudeSpanPx: match.maskAmplitudeSpan,
    });
  }

  // 🔑 **造影前を特別扱いしない。** 自分自身は候補として入れてあり（`selfMaskFrames`）、
  //    ZNCC の自己相関 1.0 が絶対最大なので**計算の結果として**選ばれる。
  const plan: (DsaFramePlanEntry | null)[] = match.entries.map((e) =>
    e.maskFrame == null || !frameIds[e.maskFrame]
      ? null
      : { maskImageIds: [frameIds[e.maskFrame]], maskFrames: [e.maskFrame], dx: e.dx, dy: e.dy },
  );

  // 🔴 **穴を残さない。** 残った `null`（追尾が外れたフレーム）は、時間方向にいちばん近い
  //    当たったフレームのマスクを流用する。ラン既定のマスクへ落とすと、そのフレームだけ
  //    露出も位相も違う絵になる——実機で利用者が「たまに明るいフレーム」として見たものである。
  let filled = 0;
  for (let t = 0; t < plan.length; t++) {
    if (plan[t] || t < contrastStart) continue;
    let src: DsaFramePlanEntry | null = null;
    for (let d = 1; d < plan.length && !src; d++) {
      src = plan[t - d] ?? plan[t + d] ?? null;
    }
    if (!src) continue;
    plan[t] = { maskImageIds: [...src.maskImageIds], maskFrames: [...src.maskFrames], dx: src.dx, dy: src.dy };
    filled++;
  }
  const liveCount = Math.max(1, n - contrastStart);
  if (filled > liveCount * MAX_FILLED_FRACTION) {
    return fail("tooManyFilled", {
      ...common, bpm, matchedFrames: matched, filledFrames: filled,
      amplitudeSpanPx: match.maskAmplitudeSpan,
    });
  }

  // ── エッジ残差の先回り計算（5-G・トグルで即座に切れるよう別枠で持つ） ──
  let alignedFrames = 0;
  if (!cancelled()) {
    params.onProgress?.({ step: "align" });
    try {
      const res = await ask(
        {
          type: "alignPlan",
          frames: { values: half, frameCount: n, width: hw, height: hh },
          // 🔑 造影前は自分自身なので残差は定義上 0。計算させない。
          maskFrameFor: plan.map((e, t) => (t < contrastStart ? null : e?.maskFrames[0] ?? null)),
          baseDx: plan.map((e) => e?.dx ?? 0),
          baseDy: plan.map((e) => e?.dy ?? 0),
          logarithmic,
          searchRadius: ALIGN_RADIUS_HALF,
        },
        [half.buffer],
      );
      if (res.type === "alignPlanDone") {
        const done = res as TrackingAlignPlanResponse;
        alignedFrames = done.aligned;
        for (let t = 0; t < plan.length; t++) {
          const a = done.align[t];
          const e = plan[t];
          if (e && a) {
            e.alignDx = a.dx;
            e.alignDy = a.dy;
            if (a.rotationDeg) e.alignRotationDeg = a.rotationDeg;
          }
        }
      }
    } catch {
      // 残差が出なくても計画そのものは使える。**黙って計画ごと捨てない。**
      alignedFrames = 0;
    }
  }

  return {
    ...common,
    diagnostics: diag,
    ok: true,
    method: "tracking",
    // 🚨 `common` は落ちどころ用に `plan: selfPlan` を持っている。**後に置いて上書きする**
    //    ——順序を逆にすると、成功しているのに造影前だけの計画が入る。
    plan,
    bpm,
    matchedFrames: matched,
    clampedFrames: match.summary.clamped,
    filledFrames: filled,
    alignedFrames,
    amplitudeSpanPx: match.maskAmplitudeSpan,
    medianAmplitudeDiff: match.summary.medianAmplitudeDiff,
  };
}
