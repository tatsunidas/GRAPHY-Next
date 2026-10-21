/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 再実行（計算ジョブの窓から）。台帳の記録で要求を作り直し、main の窓で同意を取り直し、同じ一括の次の試行として走らせる。
// 要求は本体が記録したプラグインの名で作る（窓はプラグインを名乗れない）。設計: fw/remote-compute-design.md §28。
import { apiBase } from "../apiBase";
import { desktop } from "../desktopBridge";
import { resolveComputeEndpoint } from "../plugins/pluginComputeApi";
import type { RerunCreated } from "./computeJobsApi";

export type RerunTarget = { kind: "job"; id: string } | { kind: "batch"; id: string };

export type RerunOutcome =
  | { ok: true; batchId: string; refused: { key: string; reason: string }[] }
  | {
      ok: false;
      /** 利用者が同意の窓で取り消した（エラーとして出さない）。 */
      cancelled?: boolean;
      error: string;
      refused?: { key: string; reason: string }[];
      neededBytes?: number;
      freeBytes?: number;
    };

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * 再実行を始める。{@code recordedEndpointId} は記録の計算機（Colab のランタイム確保・自機の起動を含む決定は
 * {@link resolveComputeEndpoint}）。{@code endpointOverride} は計算機を選び直すとき。
 */
export async function startRerun(
  target: RerunTarget,
  recordedEndpointId: string | null,
  endpointOverride?: string,
): Promise<RerunOutcome> {
  const d = desktop();
  if (!d?.computeConfirm || !d.computeEndpointsGet) return { ok: false, error: "desktop-only" };

  // 計算機を使える状態にしてから要求を作る（同意画面に実際の送り先が出るように）。確保だけでは何も送らない
  const resolved = await resolveComputeEndpoint(d, endpointOverride ?? recordedEndpointId ?? undefined);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const path = target.kind === "job"
    ? `/api/compute/jobs/${encodeURIComponent(target.id)}/rerun`
    : `/api/compute/batches/${encodeURIComponent(target.id)}/rerun-failed`;
  let created: { status: number; json: Record<string, unknown> };
  try {
    created = await post(path, { endpointId: resolved.endpointId });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (created.status !== 200) {
    const j = created.json;
    return {
      ok: false,
      error: typeof j.error === "string" ? j.error : `http-${created.status}`,
      ...(Array.isArray(j.refused) ? { refused: j.refused as { key: string; reason: string }[] } : {}),
      ...(typeof j.neededBytes === "number" ? { neededBytes: j.neededBytes } : {}),
      ...(typeof j.freeBytes === "number" ? { freeBytes: j.freeBytes } : {}),
    };
  }
  const req = created.json as unknown as RerunCreated;

  // 同意（main の窓。毎回聞く。前の実行の承認は使えない）
  const consent = await d.computeConfirm(req.requestId);
  if (!consent.ok) return { ok: false, error: consent.error };
  if (!consent.approved) return { ok: false, cancelled: true, error: "canceled" };

  let run: { status: number; json: Record<string, unknown> };
  try {
    run = await post("/api/compute/reruns/run", { requestId: req.requestId });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (run.status !== 200) return { ok: false, error: typeof run.json.error === "string" ? run.json.error : `http-${run.status}` };
  return { ok: true, batchId: String(run.json.batchId ?? req.rerun.batchId), refused: req.refused ?? [] };
}
