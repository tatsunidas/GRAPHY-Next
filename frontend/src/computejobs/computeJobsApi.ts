/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 計算ジョブの台帳（backend の ComputeJobsController）。web モードでは 404（standalone のみ）。
// 患者名は返らない。画面が表示のときに保管庫から UID で引く（computeJobsNames.ts）。
import { apiBase } from "../apiBase";
import { extractErrorMessage, httpGet, httpSend } from "../http";

export type ComputeJobState =
  | "QUEUED"
  | "RUNNING"
  | "AWAITING_USER"
  | "DONE"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED";

export type ComputeLogKind = "stdout" | "stderr" | "traceback";

export interface ComputeJobInput {
  studyUid: string;
  seriesUid: string;
  format: string;
  /** 保管庫から消えたシリーズ（UID は空になっている）。 */
  deleted: boolean;
}

export interface ComputeJobView {
  id: string;
  batchId: string | null;
  state: ComputeJobState;
  phase: string | null;
  progress: number | null;
  message: string | null;
  reason: string | null;
  errorName: string | null;
  errorValue: string | null;
  attempt: number;
  itemKey: string | null;
  inputs: ComputeJobInput[];
  requestId: string | null;
  pluginJobId: string | null;
  /** 計算機の環境（backend の recordEnvironment）。取れなかった項目は null、GPU が無ければ空配列。 */
  env: { python?: string | null; torch?: string | null; cuda?: string | null; gpu?: string[] | null } | null;
  remoteCleanup: string | null;
  queuedAt: string | number | null;
  startedAt: string | number | null;
  finishedAt: string | number | null;
  outputsBytes: number | null;
  collectedAt: string | number | null;
  // バッチの記録があるときだけ。
  /** 対話の 1 回（runJob）なら true、一括なら false。 */
  interactive?: boolean;
  /** 一括が一時停止中のとき、その理由（`endpoint-unreachable`）。 */
  pausedReason?: string | null;
  pluginId?: string | null;
  pluginName?: string | null;
  pluginVersion?: string | null;
  pluginPackageSha256?: string | null;
  codeSha256?: string | null;
  endpointId?: string | null;
  endpointLabel?: string | null;
  endpointKind?: string | null;
  endpointHost?: string | null;
  plaintext?: boolean | null;
  timeoutSec?: number | null;
}

const BASE = "/api/compute/jobs";

export const fetchComputeJobs = () => httpGet<ComputeJobView[]>(BASE);

export const fetchComputeJob = (id: string) => httpGet<ComputeJobView>(`${BASE}/${encodeURIComponent(id)}`);

/** ログの全文。無ければ（まだ出ていない）null。 */
export async function fetchComputeLog(id: string, kind: ComputeLogKind): Promise<string | null> {
  const res = await fetch(`${apiBase()}${BASE}/${encodeURIComponent(id)}/log/${kind}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.text();
}

export const cancelComputeJob = (id: string) =>
  httpSend<ComputeJobView>(`${BASE}/${encodeURIComponent(id)}/cancel`, "POST");

/** 一時停止中の一括を続ける（待ちのままの組を元の順で並べ直す）。 */
export const resumeComputeBatch = (batchId: string) =>
  httpSend<{ requeued: number }>(`/api/compute/batches/${encodeURIComponent(batchId)}/resume`, "POST");

/** 一括を中止する（待ちの組は計算機へ何も送らず、実行中の組は中断する）。 */
export const cancelComputeBatch = (batchId: string) =>
  httpSend<{ cancelled: number }>(`/api/compute/batches/${encodeURIComponent(batchId)}/cancel`, "POST");

export const deleteComputeJob = (id: string) => httpSend(`${BASE}/${encodeURIComponent(id)}`, "DELETE");
