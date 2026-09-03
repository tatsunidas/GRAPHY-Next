/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * TIMI フレームカウント（TFC / CTFC）の純ロジック（`fw/angio-design.md` §24・A15）。
 *
 * <h3>何を測るのか</h3>
 * 造影剤が冠動脈の入口部に入った最初のフレームから、**血管ごとに決まった遠位の指標点**に
 * 到達したフレームまでのフレーム数。血流の速さの代用指標。
 *
 * <h3>🔴 30 フレーム/秒が定義の前提である</h3>
 * TFC は **30fps での撮影を前提に定義されている**。実際の撮影レートが違えば換算が要る。
 * 換算しない生のフレーム数を「TFC」と称して出すと、**撮影条件が違うだけで別の数字になる**。
 *
 * <h3>🔴 換算は「フレーム差 × 30 / fps」ではなく経過時間から出す</h3>
 * <pre>
 *   TFC30 = (times[end] − times[start]) / 1000 × 30
 * </pre>
 * 一様レートなら `frames × 30 / fps` と厳密に一致するが、**FrameTimeVector が可変な収集
 * （可変レート DSA）では一致しない**。平均 fps で割ると静かに嘘になるので、
 * **必ず {@link frameStartTimesMs} の経過時間を使う**。両式の一致は vitest で固定してある。
 *
 * <h3>🔴 撮影レートが分からないときは数字を出さない</h3>
 * `resolveXaFps` はタグが 1 つも無いと既定 15fps へ落ちる（`source === "default"`）。
 * **既定値は測定値ではない。** それで換算した TFC30 は「測っていないものを測ったふりで出す」
 * ことになるので、`tfc30` も `ctfc` も `elapsedMs` も `null` を返し、生のフレーム差だけを出す。
 *
 * <h3>🚨 これは TIMI flow grade ではない</h3>
 * TIMI flow grade（0〜3 の定性評価）とは別の指標。混同されやすいので UI にも明示する。
 * 正常/異常の判定もしない（正常値データベースを持たないため。QLV と同じ構え）。
 */
import { frameStartTimesMs, resolveXaFps, type XaCineSource, type XaFpsSource } from "./xaCine";

/** TFC の定義が前提とする撮影レート [fps]。 */
export const TIMI_REFERENCE_FPS = 30;

/**
 * CTFC（corrected TFC）の除数。LAD は他枝より長いので補正する。
 * 🔴 **LAD 以外には掛けない。**
 */
export const CTFC_LAD_FACTOR = 1.7;

/** 撮影レートが定義の 30fps とみなせる許容 [fps]。 */
const RATE_TOLERANCE_FPS = 0.5;

/**
 * 対象の血管。**自動判定はしない**（画像から冠動脈の種類は決められない）。
 * 指標点が血管ごとに違うので、選ばれるまで結果を出さない。
 */
export type TimiVessel = "lad" | "lcx" | "rca";

export const TIMI_VESSELS: readonly TimiVessel[] = ["lad", "lcx", "rca"];

/** フレームをどうやって決めたか。**自動確定は無い**（候補は人が押して初めて入る）。 */
export type TimiFrameSelection = "manual" | "assisted";

export type TimiWarning =
  /** 撮影レートのタグが 1 つも無い＝既定値に落ちている。**換算値を出さない。** */
  | "fpsUnknown"
  /** 撮影が 30fps ではない（換算した事実を読み手に明示する）。 */
  | "rateNot30"
  /** FrameTimeVector が非一様（fps は平均であり、換算は経過時間から行っている）。 */
  | "variableFrameTime"
  /** 到達が開始以前。 */
  | "endBeforeStart"
  /** 開始がランの先頭＝入口部への流入を観測できていない可能性。 */
  | "startAtFirstFrame"
  /** 到達がランの末尾＝造影が途中で切れている可能性。 */
  | "endAtLastFrame"
  /** 差分（DSA）表示のまま測った。 */
  | "subtracted";

export interface TimiInput {
  vessel: TimiVessel;
  /** 0 origin。画面には +1 して出す。 */
  startFrame: number;
  endFrame: number;
  cine: XaCineSource;
  /** 差分表示のまま測ったか（出自として残す）。 */
  subtracted?: boolean;
}

export interface TimiResult {
  vessel: TimiVessel;
  startFrame: number;
  endFrame: number;
  /** `endFrame − startFrame`＝**フレーム間隔の数**（§24 の規約）。 */
  frames: number;
  /** 開始から到達までの経過時間 [ms]。撮影レート不明なら null。 */
  elapsedMs: number | null;
  /** 30fps に正規化したフレームカウント。撮影レート不明なら null。 */
  tfc30: number | null;
  /** LAD のときだけ `tfc30 / 1.7`。それ以外と、`tfc30` が null のときは null。 */
  ctfc: number | null;
  fps: number;
  fpsSource: XaFpsSource;
  /** フレーム間隔が一様か（FrameTimeVector が可変なら false）。 */
  rateUniform: boolean;
  unit: "frames@30fps" | "frames";
  /** 方式の識別子（検証側が期待値を切り替えられるように）。 */
  method: string;
  warnings: TimiWarning[];
}

/** フレーム間隔が一様か（可変レート収集の検出）。 */
export function isUniformFrameTime(cine: XaCineSource): boolean {
  const times = frameStartTimesMs(cine);
  if (times.length < 3) return true;
  const first = times[1] - times[0];
  if (!(first > 0)) return false;
  for (let i = 2; i < times.length; i++) {
    const step = times[i] - times[i - 1];
    // 1/1000 の相対差までは同じ間隔とみなす（浮動小数の丸め）。
    if (Math.abs(step - first) > first * 1e-3) return false;
  }
  return true;
}

/**
 * 2 フレーム間の経過時間 [ms]。範囲外・逆順は null。
 *
 * 🔴 **フレーム差 × 1 フレームの時間で代用しない。** 可変レート収集で合わなくなる。
 */
export function frameElapsedMs(cine: XaCineSource, startFrame: number, endFrame: number): number | null {
  const times = frameStartTimesMs(cine);
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) return null;
  if (startFrame < 0 || endFrame < 0) return null;
  if (startFrame >= times.length || endFrame >= times.length) return null;
  if (endFrame <= startFrame) return null;
  return times[endFrame] - times[startFrame];
}

/**
 * CTFC。**LAD のときだけ**補正を掛ける。
 *
 * 🔴 `tfc30` が null（＝撮影レート不明で換算できていない）なら null を返す。
 * 未換算の生フレーム数を 1.7 で割った値には意味が無い。
 */
export function ctfcForVessel(vessel: TimiVessel, tfc30: number | null): number | null {
  if (tfc30 == null) return null;
  return vessel === "lad" ? tfc30 / CTFC_LAD_FACTOR : null;
}

/**
 * TIMI フレームカウントを計算する。
 *
 * <p>数字を出せない条件では `tfc30` / `ctfc` / `elapsedMs` を null にし、理由を `warnings` に入れる。
 * **呼び出し側は null を 0 や生フレーム差で埋めないこと**（それをやると「換算しない値」が
 * 「換算した値」の顔をして出る）。
 */
export function computeTimiFrameCount(input: TimiInput): TimiResult | null {
  const { vessel, startFrame, endFrame, cine } = input;
  const frameCount = Math.max(1, Math.floor(cine.numberOfFrames));
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) return null;
  if (startFrame < 0 || endFrame < 0) return null;
  if (startFrame >= frameCount || endFrame >= frameCount) return null;

  const { fps, source } = resolveXaFps(cine);
  const rateUniform = isUniformFrameTime(cine);
  const warnings: TimiWarning[] = [];

  // 🔴 撮影レートが分からないなら換算しない。既定値は測定値ではない。
  const rateKnown = source !== "default";
  if (!rateKnown) warnings.push("fpsUnknown");
  if (rateKnown && Math.abs(fps - TIMI_REFERENCE_FPS) > RATE_TOLERANCE_FPS) warnings.push("rateNot30");
  if (!rateUniform) warnings.push("variableFrameTime");

  if (endFrame <= startFrame) {
    warnings.push("endBeforeStart");
    return {
      vessel,
      startFrame,
      endFrame,
      frames: endFrame - startFrame,
      elapsedMs: null,
      tfc30: null,
      ctfc: null,
      fps,
      fpsSource: source,
      rateUniform,
      unit: "frames",
      method: METHOD,
      warnings,
    };
  }

  if (startFrame === 0) warnings.push("startAtFirstFrame");
  if (endFrame === frameCount - 1) warnings.push("endAtLastFrame");
  if (input.subtracted) warnings.push("subtracted");

  const elapsedMs = rateKnown ? frameElapsedMs(cine, startFrame, endFrame) : null;
  const tfc30 = elapsedMs != null ? (elapsedMs / 1000) * TIMI_REFERENCE_FPS : null;

  return {
    vessel,
    startFrame,
    endFrame,
    frames: endFrame - startFrame,
    elapsedMs,
    tfc30,
    ctfc: ctfcForVessel(vessel, tfc30),
    fps,
    fpsSource: source,
    rateUniform,
    unit: tfc30 != null ? "frames@30fps" : "frames",
    method: METHOD,
    warnings,
  };
}

const METHOD = "TIMI frame count (elapsed time normalised to 30 fps)";

/* ------------------------------------------------------------------ */
/* 到達フレームの「候補」— 決定はしない                                 */
/* ------------------------------------------------------------------ */

/** 矩形（画像 px・端を含む）。 */
export interface TimiRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 矩形の中の平均値。
 *
 * 🚨 **矩形の外を数えない。** ROI を切らずに画面全体を平均すると、横隔膜・脊椎・カテーテル・
 * 大動脈を見てしまう（QLV で実際に踏んだ・§9.2）。呼び出し側に「ROI 無しなら全画面」という
 * 逃げ道を作らないこと。
 */
export function meanInRect(values: Float32Array | number[], width: number, height: number, rect: TimiRect): number | null {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(Math.min(rect.x0, rect.x1))));
  const x1 = Math.max(0, Math.min(width - 1, Math.ceil(Math.max(rect.x0, rect.x1))));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(Math.min(rect.y0, rect.y1))));
  const y1 = Math.max(0, Math.min(height - 1, Math.ceil(Math.max(rect.y0, rect.y1))));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      const v = values[row + x];
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
  }
  return n > 0 ? sum / n : null;
}

export interface ArrivalCandidateOptions {
  /** ベースラインを取るフレーム数（先頭から）。 */
  baselineFrames?: number;
  /** ベースラインの標準偏差の何倍を超えたら「立ち上がった」とみなすか。 */
  sigma?: number;
  /** 造影剤で暗くなる（非差分）か明るくなる（差分）か。 */
  direction?: "darker" | "brighter";
}

/**
 * 時間輝度カーブから到達フレームの**候補**を返す。見つからなければ null。
 *
 * <h3>🔴 これは候補であって決定ではない</h3>
 * 返り値をそのまま結果に入れてはいけない。**人が押して初めて確定する**（`"assisted"`）。
 * 理由は §24.1——「指標点に造影剤が入った」の定義は、ROI 平均輝度の立ち上がりと
 * **近いが同じではない**。閾値を跨いだ最初の点を自動採用すると、
 * **「測っていないものを測ったふりで出す」**ことになる。
 *
 * <p>⚠️ **開始フレームにはこの関数を使わない。** 開始の定義は「造影剤が血管の全幅を満たし、
 * かつ順行性に前進している」で、ROI の平均輝度は**どちらも見ていない**。
 * 候補を出せない側には出さない、が設計。
 *
 * @param curve フレーム順の平均値（欠測は null）
 */
export function arrivalCandidate(
  curve: readonly (number | null)[],
  opts: ArrivalCandidateOptions = {},
): number | null {
  const baselineFrames = Math.max(2, Math.floor(opts.baselineFrames ?? 5));
  const sigma = opts.sigma ?? 3;
  const direction = opts.direction ?? "darker";

  const base: number[] = [];
  for (let i = 0; i < curve.length && base.length < baselineFrames; i++) {
    const v = curve[i];
    if (v != null && Number.isFinite(v)) base.push(v);
  }
  if (base.length < 2) return null;
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const variance = base.reduce((a, b) => a + (b - mean) * (b - mean), 0) / base.length;
  const sd = Math.sqrt(variance);
  // ⚠️ 完全に平坦なベースライン（合成画像など）では sd が 0 になる。そのときは
  //    「1 でも動いたら立ち上がり」になってしまうので、床を置く。
  const threshold = Math.max(sd * sigma, Math.abs(mean) * 1e-3);

  // ベースライン区間より前は返さない（自分自身の材料を「到達」と呼ばない）。
  for (let i = base.length; i < curve.length; i++) {
    const v = curve[i];
    if (v == null || !Number.isFinite(v)) continue;
    const delta = direction === "darker" ? mean - v : v - mean;
    if (delta > threshold) return i;
  }
  return null;
}
