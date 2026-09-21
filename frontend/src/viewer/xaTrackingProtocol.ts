/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `XaTrackingDialog.tsx`（アプリ側）と `xaTrackingWorker.ts`（Worker 側）が共有する
 * postMessage プロトコルの型（`fw/angio-design.md` §6.7）。
 * DOM / WebWorker 固有のグローバルを使わないので双方の tsconfig から参照できる。
 *
 * <h3>🔴 画素は「連結した 1 本」で送る</h3>
 * `Float32Array[]` を素直に渡すと配列の要素ごとに構造化複製が走り、transfer も 1 本ずつになる。
 * フレーム数が 3 桁になる XA では、**1 本の `Float32Array` に連結して 1 回で transfer** する
 * ほうが速く、メモリのピークも低い。フレーム `t` は `[t*w*h, (t+1)*w*h)`。
 *
 * <h3>🔴 送る画素を用途で変える</h3>
 * <ul>
 *   <li><b>候補出し</b>（`suggest`）… 画面全体が要るが、タイルの採点に全フレームは要らないので
 *       <b>時間方向に間引いて</b>送る。</li>
 *   <li><b>追尾</b>（`analyze`）… 全フレームが要るが、ROI の周り（探索半径＋余白）だけでよい。
 *       <b>切り出して</b>送る。1024²・150 フレームを丸ごと送ると 600MB を超える。</li>
 * </ul>
 */
import type { PixelRect, StructureTensor } from "./edgeFilters";
import type { PhaseMaskEntry, PhaseMaskPlan } from "./xaPhaseMask";
import type { PeriodEstimate, RoiCandidate, TrackedFrame } from "./xaTracking";

/** 連結した画素列（フレーム `t` は `[t*width*height, (t+1)*width*height)`）。 */
export interface PackedFrames {
  values: Float32Array;
  frameCount: number;
  width: number;
  height: number;
}

/** 追尾に向いた ROI の候補を出す。`frames` は**間引いた全画面**。 */
export interface TrackingSuggestRequest {
  type: "suggest";
  requestId: number;
  frames: PackedFrames;
  /** `frames` の中での参照フレームの位置。 */
  referenceIndex: number;
  logarithmic: boolean;
  /** タイルの一辺 [px]。複数渡すと同じ土俵で採点する（`tileSizes` が優先）。 */
  tileSize: number;
  tileSizes?: number[];
  /** 各フレームの開始時刻 [ms]。渡すと ROI の採点が「心拍帯の動き」になる。 */
  frameStartTimesMs?: number[];
  maxCandidates: number;
  /** 追尾まで試す候補の数（省略時は `suggestTrackingRois` の既定 24）。 */
  shortlist?: number;
}

export interface TrackingSuggestResponse {
  type: "suggestDone";
  requestId: number;
  /** `rect` は**全画面の座標**。 */
  candidates: RoiCandidate[];
}

/** 追尾して運動信号・周期・位相まで出す。`frames` は**切り出した全フレーム**。 */
export interface TrackingAnalyzeRequest {
  type: "analyze";
  requestId: number;
  frames: PackedFrames;
  /** 切り出しの左上（全画面座標）。結果を全画面へ戻すために持つ。 */
  originX: number;
  originY: number;
  /** **切り出し座標系**の ROI。 */
  roi: PixelRect;
  referenceFrame: number;
  logarithmic: boolean;
  searchRadius: number;
  /** 各フレームの開始時刻 [ms]（`xaCineTiming.frameStartTimesMs()`）。可変レートに対応するため。 */
  frameStartTimesMs: number[];
}

export interface TrackingAnalyzeResponse {
  type: "analyzeDone";
  requestId: number;
  /** 追尾結果（`dx`/`dy` は参照フレームからの変位 [px]）。 */
  frames: TrackedFrame[];
  tensor: StructureTensor;
  trackReliable: boolean;
  trackReason?: string;
  /** 運動信号（px のまま）。 */
  s: Float64Array;
  sdot: Float64Array;
  axis: [number, number];
  signalReliable: boolean;
  period: PeriodEstimate;
  /** 位相（**交差確認用**。対応付けの主役ではない）。 */
  phase: Float64Array;
  peaks: number[];
  phaseReliable: boolean;
}

/**
 * 造影前 / 造影後のフレームを対応付ける（同位相マスク）。
 *
 * <p>🔴 **両方のランを同じ ROI・同じ切り出しで渡すこと。** 振幅を px で直接比べるのが
 * amplitude sorting の要点なので、ROI が違えば数値の意味が変わる。
 */
export interface TrackingMatchRequest {
  type: "match";
  requestId: number;
  /** ライブ run（造影後）の切り出し。 */
  live: PackedFrames;
  /** マスク run（造影前）の切り出し。**同一ラン内で探すなら null**。 */
  mask: PackedFrames | null;
  /** 切り出し座標系の ROI。 */
  roi: PixelRect;
  liveReference: number;
  maskReference: number;
  logarithmic: boolean;
  searchRadius: number;
  liveTimesMs: number[];
  maskTimesMs: number[];
  /** マスクに使ってよいフレーム（同一ランなら造影到達より前）。 */
  usableMaskFrames: number[];
  k: number;
  /** 範囲外のフレームを振幅の端へ丸めて当てる（自動同位相 DSA は true）。 */
  clampOutOfRange?: boolean;
  /** 自分自身をマスク候補に入れてよいライブフレーム（造影が入っていないもの）。 */
  selfMaskFrames?: number[];
}

export interface TrackingMatchResponse {
  type: "matchDone";
  requestId: number;
  entries: PhaseMaskEntry[];
  summary: PhaseMaskPlan["summary"];
  /** ラン間の定数ずれ [px]（同一ランなら 0）。寝台や体位の差。 */
  runOffset: { dx: number; dy: number };
  livePeriod: PeriodEstimate;
  maskPeriod: PeriodEstimate;
  /** 追尾できたフレーム数（分母は各ランのフレーム数）。 */
  liveTracked: number;
  maskTracked: number;
  liveFrameCount: number;
  maskFrameCount: number;
  /** マスク側の運動信号の広がり [px]（p10–p90）。**これが小さいと振幅で並べ替えられない**。 */
  maskAmplitudeSpan: number;
  /**
   * ライブ run の運動信号（px のまま・デトレンド済み）。**診断表示のため**。
   * 形は {@link TrackingAnalyzeResponse} に倣っている。
   */
  liveSignal: Float64Array;
  /** ライブ run のフレームごとの追尾。`score` が**追尾の** ZNCC。 */
  liveFrames: TrackedFrame[];
}

/**
 * 計画の各フレームについて、**エッジ像での残差のずらし**を求める（5-G）。
 *
 * <h3>🔴 半分の解像度で送る</h3>
 * 全画面 × 全フレームは 1024²・150 枚で 600MB 級（§6.7.7）。2 倍ダウンサンプルすれば
 * 137 × 256² × 4B ＝ 36MB に収まる。求めるのは**追尾の上に乗せる残差**なので、
 * 半解像度のサブピクセルを 2 倍しても実寸 0.1px 級の精度があり、用途には足りる。
 */
export interface TrackingAlignPlanRequest {
  type: "alignPlan";
  requestId: number;
  /** **2 倍ダウンサンプルした全画面**の全フレーム。 */
  frames: PackedFrames;
  /** ライブフレーム t に当てるマスクフレーム（`null` は計画の穴）。 */
  maskFrameFor: (number | null)[];
  /** 追尾から出ている既定のずらし [px]（**全解像度**）。ここからの差分だけを探す。 */
  baseDx: number[];
  baseDy: number[];
  logarithmic: boolean;
  /** 半解像度での探索半径 [px]（既定 4 ＝ 実寸 ±8px）。 */
  searchRadius: number;
}

export interface TrackingAlignPlanResponse {
  type: "alignPlanDone";
  requestId: number;
  /** **全解像度**での残差 [px]。合わなかったフレームは null。 */
  align: ({ dx: number; dy: number } | null)[];
  aligned: number;
}

export type XaTrackingWorkerRequest =
  | TrackingSuggestRequest
  | TrackingAnalyzeRequest
  | TrackingMatchRequest
  | TrackingAlignPlanRequest;

export interface TrackingErrorResponse {
  type: "error";
  requestId: number;
  message: string;
}

export type XaTrackingWorkerResponse =
  | TrackingSuggestResponse
  | TrackingAnalyzeResponse
  | TrackingMatchResponse
  | TrackingAlignPlanResponse
  | TrackingErrorResponse;
