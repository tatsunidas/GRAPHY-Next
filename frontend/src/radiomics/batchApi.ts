/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 特徴量の一括抽出の API（backend `/api/radiomics/batch`）。型は backend の record の JSON そのまま。
 * 計算するのは「利用者が確認した組」だけで、サーバーは `NEEDS_CONFIRMATION` を黙って採否しない。
 */
import { httpGet, httpSend } from "../http";
import type { RoiFeatureResult, RoiMode } from "../api";

export type BatchPairStatus = "AUTO" | "NEEDS_CONFIRMATION" | "EXCLUDED";

export interface BatchPair {
  studyUid: string;
  /** NEEDS_CONFIRMATION のときは null。利用者が選んで埋めてから送る。 */
  sourceSeriesUid: string | null;
  maskSeriesUid: string;
  segmentNumber: number | null;
  segmentLabel: string | null;
  /** セグメント番号ではなく、前景のあるセグメントを番号の昇順に並べた添字（0 始まり）。 */
  maskChannel: number;
  status: BatchPairStatus;
  reason: string | null;
  sourceCandidates: string[];
}

export interface BatchPlanRequest {
  albumId: number | null;
  studyUids: string[] | null;
}

/** QC に当たった組の扱い。FLAG＝記録して続ける、STOP＝その組の結果を残してジョブを止める。 */
export type BatchQcMode = "FLAG" | "STOP";

export interface BatchQc {
  smallRoi: BatchQcMode;
  lossy: BatchQcMode;
}

/** QC の旗。SMALL_ROI は環境設定の基準値が未設定なら立たない（「判定していない」）。 */
export type BatchQcFlag = "SMALL_ROI" | "LOSSY_COMPRESSION";

export interface BatchRequest {
  pairs: BatchPair[];
  settings: Record<string, string>;
  roiModes: RoiMode[];
  scales: number[] | null;
  scaleNotation: string | null;
  scaleLabels: string[] | null;
  scaleConversion: string | null;
  scaleCoefficient: number | null;
  channel: number;
  timePoint: number;
  recompute: boolean;
  /** null は両方とも記録だけ（従来の要求）。 */
  qc: BatchQc | null;
  /** 許容した組のキー（`pairKey`）。この組は QC で止めない。 */
  qcAcknowledged: string[] | null;
}

export type BatchJobState = "QUEUED" | "RUNNING" | "DONE" | "STOPPED" | "CANCELLED";
export type BatchPairState = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED" | "NOT_RUN" | "CANCELLED";
/** INPUT＝入力固有、ENGINE＝入力かエンジンか区別できない、ENVIRONMENT＝IO・メモリ（残りを止める）。 */
export type BatchFailureKind = "INPUT" | "ENGINE" | "ENVIRONMENT";

export interface BatchPairStatusRow {
  index: number;
  pair: BatchPair;
  state: BatchPairState;
  failureKind: BatchFailureKind | null;
  error: string | null;
  fromCache: boolean;
  elapsedMs: number;
  qcFlags: BatchQcFlag[];
}

export interface BatchStatus {
  jobId: string;
  state: BatchJobState;
  elapsedMs: number;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  notRun: number;
  cancelled: number;
  /** QC なら旗の並び（`SMALL_ROI,LOSSY_COMPRESSION`）、環境障害ならそのメッセージ。 */
  stopReason: string | null;
  /** QC＝利用者の確認待ち、ENVIRONMENT＝IO・メモリの障害。止まっていなければ null。 */
  stopKind: "QC" | "ENVIRONMENT" | null;
  stopIndex: number | null;
  pairs: BatchPairStatusRow[];
}

export interface BatchPairResult {
  index: number;
  pair: BatchPair;
  result: RoiFeatureResult;
}

export const BATCH_FINISHED: ReadonlySet<BatchJobState> = new Set(["DONE", "STOPPED", "CANCELLED"]);

export const planBatch = (req: BatchPlanRequest) => httpSend<BatchPair[]>("/api/radiomics/batch/plan", "POST", req);

export const submitBatch = (req: BatchRequest) => httpSend<BatchStatus>("/api/radiomics/batch/jobs", "POST", req);

export const getBatch = (jobId: string) =>
  httpGet<BatchStatus>(`/api/radiomics/batch/jobs/${encodeURIComponent(jobId)}`);

export const getBatchResults = (jobId: string) =>
  httpGet<BatchPairResult[]>(`/api/radiomics/batch/jobs/${encodeURIComponent(jobId)}/results`);

/** 次の組に進まなくする。走り出した 1 組は終わる。 */
export const cancelBatch = (jobId: string) =>
  httpSend<BatchStatus>(`/api/radiomics/batch/jobs/${encodeURIComponent(jobId)}`, "DELETE");
