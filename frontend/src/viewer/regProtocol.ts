/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `regWorkerClient.ts`（アプリ側、DOM lib）と `regWorker.ts`（Worker 側、WebWorker lib）が
 * 共有する postMessage プロトコルの型だけを持つファイル。
 *
 * <p>`levelSetsProtocol.ts` と同じ作法で、DOM/WebWorker 固有のグローバル（`self` など）を
 * 一切使わない。双方の tsconfig から矛盾なく参照できる状態を保つこと。
 *
 * <p><b>`SharedArrayBuffer` は使わない</b>（設計 §6）。COOP/COEP ヘッダが必要になり、
 * web モードのホスティング条件を縛るため。ボリュームは Transferable で渡す。
 */

import type { MetricKind } from "./regMetrics";

/** ボリュームを postMessage に載せられる形にしたもの（`RegVolume` の平坦化）。 */
export interface VolumePayload {
  data: Float32Array;
  dims: [number, number, number];
  /** IOP（DICOM の並び: 行方向 3, 列方向 3）。 */
  iop: number[];
  ipp0: [number, number, number];
  pixelSpacingCol: number;
  pixelSpacingRow: number;
  /** スライスが 1 進むときの移動ベクトル（法線 × 間隔ではなく実測の IPP 差）。 */
  sliceStep: [number, number, number];
}

/** 変換の種類。UI の「変換」選択に対応する。 */
export type RegistrationMode = "rigid" | "deformable" | "rigid+deformable";

export interface RigidRequest {
  type: "rigid";
  /** 既定は "rigid"（R3 と同じ挙動）。 */
  mode?: RegistrationMode;
  requestId: number;
  fixed: VolumePayload;
  moving: VolumePayload;
  metric?: MetricKind;
  sameModality?: boolean;
  sameFrameOfReference?: boolean;
  pyramidMm?: number[];
  samplesPerIteration?: number;
  maxIterationsPerLevel?: number;
  seed?: number;
  limits?: { translationMm: number; rotationDeg: number };
  /** 非剛体のハイパーパラメータ（`mode` が非剛体を含むときだけ使う）。 */
  deformable?: {
    controlSpacingsMm?: number[];
    smoothingSigma?: number;
    maxDisplacementMm?: number;
    displacementStepMm?: number;
    descriptorSpacingMm?: number;
    regularizationWeight?: number;
  };
}

/** 実行中の中止要求。`requestId` で対象を指定する。 */
export interface AbortRequest {
  type: "abort";
  requestId: number;
}

export type RegWorkerRequest = RigidRequest | AbortRequest;

export interface RegProgressMessage {
  type: "progress";
  requestId: number;
  fraction: number;
  level: number;
  levelCount: number;
  iteration: number;
  metric: number;
}

/** 変位場（非剛体の結果）。制御格子上の変位で、`displacements` は x,y,z の順。 */
export interface DvfPayload {
  displacements: Float32Array;
  dims: [number, number, number];
  origin: [number, number, number];
  spacing: [number, number, number];
  /** 品質指標。負値率 > 0 は折り返しで、物理的にありえない（設計 §9.4）。 */
  jacobian: { min: number; max: number; negativeFraction: number };
  maxDisplacementMm: number;
}

export interface RegDoneMessage {
  type: "done";
  requestId: number;
  /** 非剛体を実行した場合の変位場。剛体のみなら undefined。 */
  dvf?: DvfPayload;
  /** 剛体の 4×4（fixed world → moving world, row-major）。剛体を実行していなければ恒等。 */
  matrix: number[];
  center: [number, number, number];
  translationMm: [number, number, number];
  eulerDeg: [number, number, number];
  metric: MetricKind;
  metricValue: number;
  levels: { spacingMm: number; iterations: number; metric: number }[];
  seed: number;
  aborted: boolean;
  initialization: string;
  /** 実行時間 [ms]。UI とベンチの両方で使う。 */
  elapsedMs: number;
}

export interface RegErrorMessage {
  type: "error";
  requestId: number;
  message: string;
}

export type RegWorkerResponse = RegProgressMessage | RegDoneMessage | RegErrorMessage;
