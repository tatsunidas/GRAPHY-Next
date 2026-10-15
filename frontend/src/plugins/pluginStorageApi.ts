/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H62: 保管庫の画像を**手元に確保する**（Drive が正本のモードで、手元に無い画像を Drive から取り寄せる）。
 *
 * <p>パスは返さない。検査・シリーズの UID を渡すだけで、本体が取り寄せる。新しい権限・同意は要らない:
 * 利用者自身の Drive にある自分のデータを手元へ戻すだけで、外へは出ない
 * （`/api/instances/...` を直接叩いても同じ取得が走る。host API は信頼境界ではない）。
 * モード A でなければ（バックアップのみ・Drive なし）何もせず `cacheMode: false` で返る。
 *
 * <p>呼び出しはプラグインの id に固定する（他のプラグインの名では呼べない）。
 */
import { HttpError, httpGet, httpSend } from "../http";
import { pollPluginJob, type PluginJobOptions, type PluginJobStatus } from "./pluginCommonApi";

export interface StorageEnsureRequest {
  studyUid: string;
  /** 省略すると検査全体。 */
  seriesUids?: string[];
}

/**
 * 結果。**例外は投げない**（`runBackendJob` と同じ流儀）。
 * `cancelled: true` は利用者の取り消しで、エラーとして表示しないこと。
 * `error` は理由コード: `offline`・`needs-login`・`drive-disabled`・`md5-mismatch`・`no-checksum`・`not-on-drive`・
 * `drive-error`（取り寄せ）、`not-found`（検査・シリーズが無い）、`invalid-*`（要求の形）。
 */
export type StorageEnsureOutcome =
  | { ok: true; total: number; fetched: number; alreadyLocal: number; cacheMode: boolean }
  | { ok: false; cancelled?: boolean; error?: string; fetched?: number };

export interface StorageStatus {
  /** Drive が正本で、手元は上限つきのキャッシュか。 */
  cacheMode: boolean;
  usedBytes: number;
  limitBytes: number;
  /** Drive にだけある（手元に無い）画像の数。 */
  remoteOnlyCount: number;
}

const MAX_UID = 64;
const MAX_SERIES = 1000;

/** 要求の形を、送る前に確かめる（backend も同じ検査をする）。問題があれば理由コード、無ければ null。 */
export function validateEnsureRequest(req: unknown): string | null {
  const r = req as Partial<StorageEnsureRequest> | null | undefined;
  if (!r || typeof r.studyUid !== "string" || r.studyUid.trim() === "" || r.studyUid.length > MAX_UID) return "invalid-study-uid";
  if (r.seriesUids !== undefined) {
    if (!Array.isArray(r.seriesUids)) return "invalid-series-uid";
    if (r.seriesUids.length > MAX_SERIES) return "too-many-series";
    for (const s of r.seriesUids) {
      if (typeof s !== "string" || s.trim() === "" || s.length > MAX_UID) return "invalid-series-uid";
    }
  }
  return null;
}

export async function ensureLocal(pluginId: string, req: StorageEnsureRequest, opts: PluginJobOptions = {}): Promise<StorageEnsureOutcome> {
  const invalid = validateEnsureRequest(req);
  if (invalid) return { ok: false, error: invalid };
  let started: PluginJobStatus;
  try {
    started = await httpSend<PluginJobStatus>(`/api/plugins/${encodeURIComponent(pluginId)}/storage/ensure`, "POST", {
      studyUid: req.studyUid,
      ...(req.seriesUids ? { seriesUids: req.seriesUids } : {}),
    });
  } catch (e) {
    return { ok: false, error: e instanceof HttpError || e instanceof Error ? e.message : String(e) };
  }
  const out = await pollPluginJob(started.jobId, opts);
  if (!out.ok) return out;
  const r = out.result as { ok?: boolean; error?: string; fetched?: number; total?: number; alreadyLocal?: number; cacheMode?: boolean } | null;
  if (!r || r.ok !== true) return { ok: false, error: r?.error ?? "failed", fetched: r?.fetched };
  return { ok: true, total: r.total ?? 0, fetched: r.fetched ?? 0, alreadyLocal: r.alreadyLocal ?? 0, cacheMode: r.cacheMode === true };
}

export const storageStatus = (pluginId: string): Promise<StorageStatus> =>
  httpGet<StorageStatus>(`/api/plugins/${encodeURIComponent(pluginId)}/storage/status`);
