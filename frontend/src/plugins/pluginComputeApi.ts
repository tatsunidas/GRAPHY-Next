/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 外部の計算機（Jupyter Server）で計算する（H59 `compute.runJob`）。設計: `fw/remote-compute-design.md` §5。
 *
 * <p>流れ（どの段も既存の仕組みに乗る）:
 * <ol>
 *   <li>要求を作る（`POST /api/plugins/{id}/compute/egress`）——本体が<b>既存の匿名化</b>でデータを作る。まだ送らない</li>
 *   <li>同意（`desktop.computeConfirm`）——<b>main の窓</b>で、宛先・データ・コードの全文を見せて聞く</li>
 *   <li>実行（`POST /api/plugins/{id}/compute/jobs`）——承認の札を使い、`PluginJobService` のジョブとして走る</li>
 *   <li>待つ（既存の `pollPluginJob`。進み具合・取り消しは H45 と同じ）</li>
 *   <li>結果のファイルは H53 の成果物（`outputs.zip`）。`readFile(name)` で 1 つずつ取り出せる</li>
 * </ol>
 *
 * <p>プラグインが渡せるのは<b>シリーズの参照とコード</b>だけ。画素のバイト列を外へ送る口は無い。
 * 例外は投げない（`ai.generate` と同じ流儀）。`cancelled: true` は利用者の取り消しで、エラーとして出さないこと。
 */
import { apiBase } from "../apiBase";
import { desktop } from "../desktopBridge";
import { HttpError, httpSend } from "../http";
import { pollPluginJob, type PluginJobOptions, type PluginJobStatus } from "./pluginCommonApi";
import type { PluginManifest } from "./pluginTypes";

/** 必要な権限（`plugin.json` の `permissions`）。backend でも確かめる。 */
export const REMOTE_COMPUTE_PERMISSION = "remote-compute";

export interface ComputeJobInput {
  studyUid: string;
  seriesUid: string;
  /** 既定 `npz`（float32 の volume＋spacing/origin/direction）。`dicom-zip` は匿名化した DICOM。 */
  format?: "npz" | "dicom-zip";
}

export interface ComputeRunJobOptions {
  /**
   * 実行する Python。計算機の上では作業フォルダに `inputs/0.npz` … が置かれ、`outputs/` に書いたものが返る。
   * 進み具合は `print("__progress__", 0.4, "message")` で伝わる。64KB まで。
   */
  script: string;
  inputs: ComputeJobInput[];
  /** 環境設定 ＞ 外部の計算機 の ID。省略するとトークンの入った最初の計算機。 */
  endpointId?: string;
  /** 秒。既定 3600・上限 6 時間。過ぎたら中断する。 */
  timeoutSec?: number;
}

export interface ComputeOutputFile {
  name: string;
  size: number;
}

export type ComputeRunOutcome =
  | {
      ok: true;
      jobId: string;
      /** コードが最後まで走ったか（`error` は Python の例外。ジョブ自体は成功している）。 */
      status: "ok" | "error";
      stdout: string;
      stderr: string;
      errorName?: string;
      errorValue?: string;
      traceback?: string[];
      files: ComputeOutputFile[];
      /** `outputs/` のファイルを取り出す（名前は `files[].name`）。無ければ null。 */
      readFile: (name: string) => Promise<Uint8Array | null>;
    }
  | { ok: false; cancelled?: boolean; error: string };

interface EgressCreated {
  requestId: string;
}

/** H59。 */
export async function runComputeJob(
  m: PluginManifest,
  opts: ComputeRunJobOptions,
  jobOpts: PluginJobOptions = {},
): Promise<ComputeRunOutcome> {
  const d = desktop();
  if (!d?.computeConfirm || !d.computeEndpointsGet) return { ok: false, error: "desktop-only" };
  if (!(m.permissions ?? []).includes(REMOTE_COMPUTE_PERMISSION)) return { ok: false, error: "permission-denied" };

  let endpointId = opts.endpointId;
  if (!endpointId) {
    const cfg = await d.computeEndpointsGet();
    endpointId = cfg.endpoints.find((e) => e.hasToken)?.id ?? cfg.endpoints[0]?.id;
    if (!endpointId) return { ok: false, error: "no-endpoint" };
  }
  const id = encodeURIComponent(m.id);

  // 1. 要求（本体が匿名化したデータを作る。まだ送らない）
  let created: EgressCreated;
  try {
    created = await httpSend<EgressCreated>(`/api/plugins/${id}/compute/egress`, "POST", {
      endpointId,
      inputs: opts.inputs.map((i) => ({ ...i, format: i.format ?? "npz" })),
      code: opts.script,
    });
  } catch (e) {
    return { ok: false, error: errorCode(e) };
  }

  // 2. 同意（main の窓）
  const consent = await d.computeConfirm(created.requestId);
  if (!consent.ok) return { ok: false, error: consent.error };
  if (!consent.approved) return { ok: false, cancelled: true, error: "canceled" };

  // 3. 実行
  let started: PluginJobStatus;
  try {
    started = await httpSend<PluginJobStatus>(`/api/plugins/${id}/compute/jobs`, "POST", {
      requestId: created.requestId,
      timeoutSec: opts.timeoutSec,
    });
  } catch (e) {
    return { ok: false, error: errorCode(e) };
  }

  // 4. 待つ（H45 と同じ）
  const out = await pollPluginJob(started.jobId, jobOpts);
  if (!out.ok) return { ok: false, cancelled: out.cancelled, error: out.error ?? (out.cancelled ? "canceled" : "failed") };
  const r = (out.result ?? {}) as Record<string, unknown>;
  const jobId = started.jobId;
  let zip: Promise<Uint8Array | null> | null = null;
  return {
    ok: true,
    jobId,
    status: r.status === "ok" ? "ok" : "error",
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
    ...(typeof r.errorName === "string" ? { errorName: r.errorName } : {}),
    ...(typeof r.errorValue === "string" ? { errorValue: r.errorValue } : {}),
    ...(Array.isArray(r.traceback) ? { traceback: r.traceback.map(String) } : {}),
    files: Array.isArray(r.files) ? (r.files as ComputeOutputFile[]) : [],
    readFile: async (name: string) => {
      zip ??= fetchArtifact(jobId);
      const bytes = await zip;
      return bytes ? readStoredZipEntry(bytes, name) : null;
    },
  };
}

function errorCode(e: unknown): string {
  return e instanceof HttpError || e instanceof Error ? e.message : String(e);
}

async function fetchArtifact(jobId: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`${apiBase()}/api/plugin-jobs/${encodeURIComponent(jobId)}/artifact`);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 無圧縮（STORED）の zip から 1 ファイル取り出す。本体が outputs を無圧縮でまとめるので、
 * ライブラリなしで中央ディレクトリを読むだけで済む。圧縮されたエントリ・見つからない名前は null。
 */
export function readStoredZipEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // 終端レコード（EOCD）を後ろから探す（コメントは最大 64KB）
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) return null;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const entryName = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (entryName === name) {
      if (method !== 0 || v.getUint32(local, true) !== 0x04034b50) return null;
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      return zip.slice(start, start + size);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
