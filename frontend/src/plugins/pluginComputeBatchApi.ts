/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 外部の計算機で、同じコードを入力の組ごとに走らせる（一括。`compute.runBatch` / `listJobs` / `attach`）。
 * 設計: `fw/remote-compute-design.md` §26・§27。
 *
 * <p>流れは {@link ./pluginComputeApi.runComputeJob} と同じで、同意は**全組で 1 回**（main の窓が全組の行を見せる）。
 * 実行は本体の台帳（`/api/plugins/{id}/compute/jobs`）が持つので、**プラグインの画面を閉じても計算は続き**、
 * 開き直して `attach` で受け取っていない結果を受け取れる。結果は組が終わるたびに `onItem` で届く。
 *
 * <p>例外は投げない。計算機に届かなくなると一括は<b>一時停止</b>し（残りは失敗にしない）、`runBatch`・`attach` は
 * `paused: true` で返る。続きは利用者が計算ジョブの窓で［再開］を押す（本体の操作）。
 */
import { apiBase } from "../apiBase";
import { desktop } from "../desktopBridge";
import { httpGet, httpSend } from "../http";
import {
  listStoredZipEntries,
  readStoredZipEntry,
  REMOTE_COMPUTE_PERMISSION,
  resolveComputeEndpoint,
  type ComputeJobInput,
  type ComputeOutputFile,
} from "./pluginComputeApi";
import type { PluginManifest } from "./pluginTypes";

export interface ComputeBatchItemInput {
  /** 組の名前。英数字・`. _ -` の 64 字まで・重複不可。**患者名を入れないこと**（台帳・監査に残る）。 */
  key: string;
  /** 0〜8 件（1 組 = 計算機の上の 1 回の実行。`inputs/0.npz` … に並ぶ）。 */
  inputs: ComputeJobInput[];
}

export interface ComputeRunBatchOptions {
  /** 全組で同じコード（64KB まで）。 */
  script: string;
  items: ComputeBatchItemInput[];
  endpointId?: string;
  /** 1 組あたりの秒。既定 3600・上限 6 時間。 */
  timeoutSec?: number;
}

/** 台帳の 1 行の写し（患者名は含まない）。 */
export interface ComputeJobSummary {
  jobId: string;
  batchId: string | null;
  /** 一括のときの組の名前。 */
  key: string | null;
  /** 同じ組の試行の番号（再実行で 2 以降）。同じ `key` のうち最大のものが最新。 */
  attempt: number;
  state: "QUEUED" | "RUNNING" | "AWAITING_USER" | "DONE" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  /** 失敗・中断の分類（`code-error` `timeout` `endpoint-unreachable` `dataset-changed` …）。 */
  reason: string | null;
  errorName: string | null;
  errorValue: string | null;
  outputsBytes: number | null;
  collected: boolean;
}

/** 終わった 1 組の結果。`runJob` の結果と同じ形に、組の名前と受け取りの印が付く。 */
export type ComputeBatchItemOutcome = { key: string | null; jobId: string; attempt: number; markCollected: () => Promise<void> } & (
  | {
      ok: true;
      /** `error` は Python の例外（組としては走り終えている）。 */
      status: "ok" | "error";
      stdout: string;
      stderr: string;
      errorName?: string;
      errorValue?: string;
      traceback?: string[];
      files: ComputeOutputFile[];
      readFile: (name: string) => Promise<Uint8Array | null>;
    }
  | { ok: false; cancelled?: boolean; error: string }
);

export interface ComputeBatchOptions {
  /** 組が終わるたびに呼ぶ（同じ組を 2 度は呼ばない）。 */
  onItem?: (item: ComputeBatchItemOutcome) => void;
  /** 終わった組の割合（0..1）と一言。 */
  onProgress?: (fraction: number, message: string) => void;
  /** 承認・投入が済んだ直後（`runBatch` のみ）。 */
  onStarted?: (info: { batchId: string; items: { key: string; jobId: string }[]; refused: ComputeBatchRefused[] }) => void;
  /** abort すると一括を中止する（待ちの組は計算機へ何も送らず、実行中の組は中断する）。 */
  signal?: AbortSignal;
  /** 台帳を読む間隔（ミリ秒）。既定 1000。 */
  pollMs?: number;
}

export interface ComputeBatchRefused {
  key: string;
  /** 送れなかった理由（焼き込み・格子など）。 */
  reason: string;
}

export interface ComputeBatchCounts {
  done: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  total: number;
}

export type ComputeBatchOutcome =
  | {
      ok: true;
      batchId: string;
      counts: ComputeBatchCounts;
      refused: ComputeBatchRefused[];
      /** 計算機に届かなくなって一時停止中。残りは待ちのまま（失敗にしていない）。 */
      paused?: boolean;
      /** 一時停止の理由（`endpoint-unreachable`）。 */
      reason?: string;
      cancelled?: boolean;
    }
  | { ok: false; cancelled?: boolean; error: string; neededBytes?: number; freeBytes?: number; refused?: ComputeBatchRefused[] };

// ── 台帳の読み取り（注入できる形にしてある。単体テスト用） ──

/** 台帳の 1 行（backend の `ComputeJobLedger.view`）のうち、ここで使う項目。 */
export interface LedgerRow {
  id: string;
  batchId: string | null;
  itemKey: string | null;
  /** 試行の番号（古い台帳の行には無い）。 */
  attempt?: number;
  state: ComputeJobSummary["state"];
  reason: string | null;
  errorName: string | null;
  errorValue: string | null;
  outputsBytes: number | null;
  collectedAt: string | number | null;
  pausedReason?: string | null;
}

export interface BatchDeps {
  listRows: (batchId: string) => Promise<LedgerRow[]>;
  fetchLog: (jobId: string, kind: "stdout" | "stderr" | "traceback") => Promise<string | null>;
  fetchZip: (jobId: string) => Promise<Uint8Array | null>;
  markCollected: (jobId: string) => Promise<void>;
  cancelBatch: (batchId: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const ENDED = new Set(["DONE", "FAILED", "CANCELLED", "INTERRUPTED"]);

export function summarize(r: LedgerRow): ComputeJobSummary {
  return {
    jobId: r.id,
    batchId: r.batchId,
    key: r.itemKey,
    attempt: r.attempt ?? 1,
    state: r.state,
    reason: r.reason,
    errorName: r.errorName,
    errorValue: r.errorValue,
    outputsBytes: r.outputsBytes,
    collected: r.collectedAt != null,
  };
}

/** 終わった行 1 つを、`runJob` と同じ形の結果にする。Python の例外（code-error）は `status: "error"` で、`ok: true`。 */
export async function buildItemOutcome(row: LedgerRow, deps: BatchDeps): Promise<ComputeBatchItemOutcome> {
  const base = { key: row.itemKey, jobId: row.id, attempt: row.attempt ?? 1, markCollected: () => deps.markCollected(row.id) };
  if (row.state === "CANCELLED") return { ...base, ok: false, cancelled: true, error: "canceled" };
  const ran = row.state === "DONE" || (row.state === "FAILED" && row.reason === "code-error");
  if (!ran) return { ...base, ok: false, error: row.reason ?? (row.state === "INTERRUPTED" ? "interrupted" : "failed") };

  let zip: Promise<Uint8Array | null> | null = null;
  const getZip = () => (zip ??= deps.fetchZip(row.id));
  const [stdout, stderr, traceback, bytes] = await Promise.all([
    deps.fetchLog(row.id, "stdout"),
    deps.fetchLog(row.id, "stderr"),
    row.state === "FAILED" ? deps.fetchLog(row.id, "traceback") : Promise.resolve(null),
    getZip(),
  ]);
  return {
    ...base,
    ok: true,
    status: row.state === "DONE" ? "ok" : "error",
    stdout: stdout ?? "",
    stderr: stderr ?? "",
    ...(row.errorName ? { errorName: row.errorName } : {}),
    ...(row.errorValue ? { errorValue: row.errorValue } : {}),
    ...(traceback ? { traceback: traceback.split("\n") } : {}),
    files: bytes ? listStoredZipEntries(bytes) : [],
    readFile: async (name: string) => {
      const b = await getZip();
      return b ? readStoredZipEntry(b, name) : null;
    },
  };
}

/**
 * 一括を台帳で見守る。終わった組から `onItem` を呼び（重複なし）、全部終わるか一時停止で返す。
 * `skipCollected` は `attach` 用（受け取り済みの組は届けない）。abort されたら一括を中止し、終わるまで見届ける。
 */
export async function watchBatch(
  batchId: string,
  deps: BatchDeps,
  opts: ComputeBatchOptions & { skipCollected?: boolean },
  refused: ComputeBatchRefused[] = [],
): Promise<ComputeBatchOutcome> {
  const pollMs = Math.max(100, opts.pollMs ?? 1000);
  const delivered = new Set<string>();
  let cancelSent = false;
  let readFailures = 0;
  for (;;) {
    if (opts.signal?.aborted && !cancelSent) {
      cancelSent = true;
      await deps.cancelBatch(batchId).catch(() => undefined);
    }
    let rows: LedgerRow[];
    try {
      rows = await deps.listRows(batchId);
      readFailures = 0;
    } catch (e) {
      // 台帳が一瞬読めないだけのことがある。続けて 3 回読めなければ諦める（計算は本体で続いている）
      if (++readFailures >= 3) return { ok: false, error: e instanceof Error ? e.message : String(e) };
      await deps.sleep(pollMs);
      continue;
    }
    if (rows.length === 0) return { ok: false, error: "unknown-batch" };
    for (const row of rows) {
      if (!ENDED.has(row.state) || delivered.has(row.id)) continue;
      delivered.add(row.id);
      if (opts.skipCollected && row.collectedAt != null) continue;
      try {
        opts.onItem?.(await buildItemOutcome(row, deps));
      } catch {
        // onItem が投げても一括の見守りは続ける（プラグイン側の不具合で計算の受け取りを止めない）
      }
    }
    const ended = rows.filter((r) => ENDED.has(r.state)).length;
    try {
      opts.onProgress?.(ended / rows.length, `${ended}/${rows.length}`);
    } catch {
      // 同上
    }
    const counts = countRows(rows);
    if (ended === rows.length) {
      return { ok: true, batchId, counts, refused, ...(opts.signal?.aborted ? { cancelled: true } : {}) };
    }
    const pausedReason = rows.map((r) => r.pausedReason).find((p) => !!p);
    if (pausedReason && !rows.some((r) => r.state === "RUNNING")) {
      return { ok: true, batchId, counts, refused, paused: true, reason: pausedReason };
    }
    await deps.sleep(pollMs);
  }
}

/** 件数は組ごとの最新の試行だけ（再実行で直した古い失敗は数えない）。 */
function countRows(all: LedgerRow[]): ComputeBatchCounts {
  const best = new Map<string, LedgerRow>();
  for (const r of all) {
    const k = r.itemKey ?? "#";
    const cur = best.get(k);
    if (!cur || (r.attempt ?? 1) >= (cur.attempt ?? 1)) best.set(k, r);
  }
  const rows = [...best.values()];
  return {
    done: rows.filter((r) => r.state === "DONE").length,
    failed: rows.filter((r) => r.state === "FAILED").length,
    cancelled: rows.filter((r) => r.state === "CANCELLED").length,
    interrupted: rows.filter((r) => r.state === "INTERRUPTED").length,
    total: rows.length,
  };
}

// ── 本物の接続（fetch） ──

function depsFor(pluginId: string): BatchDeps {
  const base = `/api/plugins/${encodeURIComponent(pluginId)}/compute/jobs`;
  return {
    listRows: (batchId) => httpGet<LedgerRow[]>(`${base}?batchId=${encodeURIComponent(batchId)}`),
    fetchLog: async (jobId, kind) => {
      try {
        const res = await fetch(`${apiBase()}${base}/${encodeURIComponent(jobId)}/log/${kind}`);
        return res.ok ? await res.text() : null;
      } catch {
        return null;
      }
    },
    fetchZip: async (jobId) => {
      try {
        const res = await fetch(`${apiBase()}${base}/${encodeURIComponent(jobId)}/artifact`);
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      } catch {
        return null;
      }
    },
    markCollected: async (jobId) => {
      await httpSend(`${base}/${encodeURIComponent(jobId)}/collected`, "POST");
    },
    cancelBatch: async (batchId) => {
      await httpSend(`/api/compute/batches/${encodeURIComponent(batchId)}/cancel`, "POST");
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

interface BatchCreated {
  requestId: string;
  items: { key: string; datasets: unknown[] }[];
  refused: ComputeBatchRefused[];
}

/** `compute.runBatch`。 */
export async function runComputeBatch(
  m: PluginManifest,
  opts: ComputeRunBatchOptions,
  bopts: ComputeBatchOptions = {},
): Promise<ComputeBatchOutcome> {
  const d = desktop();
  if (!d?.computeConfirm || !d.computeEndpointsGet) return { ok: false, error: "desktop-only" };
  if (!(m.permissions ?? []).includes(REMOTE_COMPUTE_PERMISSION)) return { ok: false, error: "permission-denied" };
  const resolved = await resolveComputeEndpoint(d, opts.endpointId);
  if (!resolved.ok) return resolved;
  const id = encodeURIComponent(m.id);

  // 1. 要求（全組を本体が匿名化して作る。送れない組は外れて refused に出る。まだ送らない）
  let created: BatchCreated;
  try {
    const res = await fetch(`${apiBase()}/api/plugins/${id}/compute/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpointId: resolved.endpointId,
        code: opts.script,
        items: opts.items.map((it) => ({ key: it.key, inputs: it.inputs.map((i) => ({ ...i, format: i.format ?? "npz" })) })),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof body.error === "string" ? body.error : `http-${res.status}`,
        ...(typeof body.neededBytes === "number" ? { neededBytes: body.neededBytes } : {}),
        ...(typeof body.freeBytes === "number" ? { freeBytes: body.freeBytes } : {}),
        ...(Array.isArray(body.refused) ? { refused: body.refused as ComputeBatchRefused[] } : {}),
      };
    }
    created = body as unknown as BatchCreated;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // 2. 同意（main の窓。全組を 1 回で見せる）
  const consent = await d.computeConfirm(created.requestId);
  if (!consent.ok) return { ok: false, error: consent.error };
  if (!consent.approved) return { ok: false, cancelled: true, error: "canceled" };

  // 3. 投入
  let started: { batchId: string; items: { key: string; jobId: string }[] };
  try {
    started = await httpSend(`/api/plugins/${id}/compute/batches/run`, "POST", {
      requestId: created.requestId,
      timeoutSec: opts.timeoutSec,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    bopts.onStarted?.({ batchId: started.batchId, items: started.items, refused: created.refused ?? [] });
  } catch {
    // プラグインの不具合で見守りを止めない
  }
  return watchBatch(started.batchId, depsFor(m.id), bopts, created.refused ?? []);
}

/** `compute.listJobs`。自分のプラグインの行だけ。 */
export async function listComputeJobs(
  m: PluginManifest,
  opts: { batchId?: string; uncollectedOnly?: boolean } = {},
): Promise<ComputeJobSummary[]> {
  if (!desktop()?.computeConfirm || !(m.permissions ?? []).includes(REMOTE_COMPUTE_PERMISSION)) return [];
  const q = new URLSearchParams();
  if (opts.batchId) q.set("batchId", opts.batchId);
  if (opts.uncollectedOnly) q.set("uncollectedOnly", "true");
  try {
    const rows = await httpGet<LedgerRow[]>(`/api/plugins/${encodeURIComponent(m.id)}/compute/jobs${q.size ? `?${q}` : ""}`);
    return rows.map(summarize);
  } catch {
    return [];
  }
}

/** `compute.attach`。画面を閉じている間に終わった組のうち、受け取っていないものを届ける。 */
export async function attachComputeBatch(
  m: PluginManifest,
  batchId: string,
  bopts: ComputeBatchOptions = {},
): Promise<ComputeBatchOutcome> {
  if (!desktop()?.computeConfirm) return { ok: false, error: "desktop-only" };
  if (!(m.permissions ?? []).includes(REMOTE_COMPUTE_PERMISSION)) return { ok: false, error: "permission-denied" };
  return watchBatch(batchId, depsFor(m.id), { ...bopts, skipCollected: true });
}
