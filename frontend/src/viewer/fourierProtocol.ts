/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `FourierDialog.tsx`（アプリ側）と `fourierWorker.ts`（Worker 側）が共有する postMessage プロトコルの型。
 * DOM / WebWorker 固有のグローバルを使わないので双方の tsconfig から参照できる。
 */
import type { FilterSpec } from "./fourier";

/** 画像 1 枚を変換し、スペクトルを Worker 内に保持する。 */
export interface FourierTransformRequest {
  type: "transform";
  requestId: number;
  /** row-major。呼び出し側はコピーを transfer で渡す（Cornerstone のキャッシュを detach しない）。 */
  values: Float32Array;
  width: number;
  height: number;
}

/** 保持中のスペクトルにフィルタを掛けて逆変換する（`kind:"none"` なら素の 2D-iDFT）。 */
export interface FourierInverseRequest {
  type: "inverse";
  requestId: number;
  filter: FilterSpec;
  sigma: number;
}

/** シフト後座標 (u, v) の基底（`weighted` なら係数の実寄与）。 */
export interface FourierBasisRequest {
  type: "basis";
  requestId: number;
  u: number;
  v: number;
  weighted: boolean;
}

export type FourierWorkerRequest = FourierTransformRequest | FourierInverseRequest | FourierBasisRequest;

export interface FourierTransformResponse {
  type: "transformDone";
  requestId: number;
  /** パディング後の一辺。 */
  n: number;
  /** 元画像を置いたパディング内の位置と大きさ（書き出しの記述に使う）。 */
  offX: number;
  offY: number;
  /** 以下はすべて n×n・**シフト後**（DC が中央）。実部・虚部は**符号付き**（係数そのもの）。 */
  real: Float32Array;
  imag: Float32Array;
  magnitude: Float32Array;
}

export interface FourierInverseResponse {
  type: "inverseDone";
  requestId: number;
  /** 元の大きさへ切り戻した逆変換の実部。 */
  real: Float32Array;
  /** 同じく絶対値（mirror なしの非対称フィルタでは実部と差が出る）。 */
  magnitude: Float32Array;
  /** シフト後の通過マスク（n×n）。 */
  mask: Float32Array;
  /** 虚部の最大絶対値（結果が実数とみなせるかの目安）。 */
  maxImag: number;
}

export interface FourierBasisResponse {
  type: "basisDone";
  requestId: number;
  u: number;
  v: number;
  image: Float32Array;
  /** その座標の係数（非シフトの F(u,v)）。 */
  coeffRe: number;
  coeffIm: number;
}

export interface FourierErrorResponse {
  type: "error";
  requestId: number;
  message: string;
}

export type FourierWorkerResponse =
  | FourierTransformResponse
  | FourierInverseResponse
  | FourierBasisResponse
  | FourierErrorResponse;
