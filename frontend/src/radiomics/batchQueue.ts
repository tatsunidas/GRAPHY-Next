/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 一括抽出の「定義の一覧」: 保存した処理の定義を複数並べ、順に実行して定義ごとに表を書き出す。
 *
 * <p>1 つの定義の実行は、画面の単独実行と同じ部品（`applySpecToForm`・`applyLabelFilter`・`buildBatchRequest`・
 * `datasetFiles`）を通すので、同じ定義・同じ結果なら同じ SHA-256・同じ表になる。API と保存先は注入する（テスト用）。
 *
 * <p>失敗の扱い: 送信・取得の失敗や入力の問題はその定義だけ `failed` にして次へ進む（障害で残りを捨てない）。
 * 利用者の取り消しだけが残りを止める（残りは `pending` のまま）。QC で止まった定義は、続ける判断が利用者のものなので
 * 表を書かず `qcStopped` にして次へ進む（単独実行で許容して続ける）。
 */
import type { BatchPairResult, BatchRequest, BatchStatus } from "./batchApi";
import { BATCH_FINISHED } from "./batchApi";
import {
  applyLabelFilter,
  assignCaseLabels,
  batchFileBase,
  buildBatchRequest,
  duplicateLabels,
  selectedPairs,
  type PairRow,
} from "./batchPairs";
import { applySpecToForm, specText, type BatchSpec } from "./batchSpec";
import { datasetFiles, type DatasetRow, type OutputFile, type SubjectInfo } from "./datasetCsv";
import type { RoiFeatureForm } from "./roiFeatureSettings";

export type QueueState = "pending" | "running" | "done" | "failed" | "qcStopped" | "cancelled";

export interface QueueEntry {
  id: number;
  spec: BatchSpec;
  enabled: boolean;
  state: QueueState;
  /** 失敗・停止の理由、または完了時のファイル数。 */
  message: string | null;
  files: number;
}

/** 書き出しの設定（画面の「出力」欄と同じ）。 */
export interface OutputContext {
  albumName: string;
  subjects: ReadonlyMap<string, SubjectInfo>;
  includePatientId: boolean;
  subjectsFile: boolean;
  bom: boolean;
}

/**
 * 1 つのジョブの結果から書き出すファイル一式を作る。画面の単独実行と一覧の実行が共有する。
 * `labels` は送った組の症例ラベル（結果の `index` で引く）、`prefix` は出力の接頭辞。
 */
export function buildDatasetOutput(
  job: BatchStatus,
  results: readonly BatchPairResult[],
  labels: readonly string[],
  spec: BatchSpec,
  prefix: string,
  out: OutputContext,
): ReturnType<typeof datasetFiles> {
  const byIndex = new Map(results.map((r) => [r.index, r.result]));
  const rows: DatasetRow[] = job.pairs.map((p) => ({ caseLabel: labels[p.index] ?? "", status: p, result: byIndex.get(p.index) ?? null }));
  return datasetFiles(rows, out.subjects, {
    albumName: out.albumName, specSha256: spec.sha256, includePatientId: out.includePatientId, base: batchFileBase(prefix),
    specText: specText({ ...spec, output: { prefix } }), subjectsFile: out.subjectsFile, bom: out.bom, kind: spec.kind,
  });
}

export interface QueueApi {
  submit(req: BatchRequest): Promise<BatchStatus>;
  get(jobId: string): Promise<BatchStatus>;
  results(jobId: string): Promise<BatchPairResult[]>;
  cancel(jobId: string): Promise<BatchStatus>;
  /** 書き出すファイルを保存する（ブラウザならダウンロード）。 */
  save(files: readonly OutputFile[]): void;
  sleep(ms: number): Promise<void>;
}

export interface QueueContext {
  baseRows: readonly PairRow[];
  baseForm: RoiFeatureForm;
  output: OutputContext;
  pollMs: number;
  /** キャッシュを使わず計算し直す（無人実行の `--recompute`）。省略は使う。 */
  recompute?: boolean;
  /** 利用者が中止を押したか。実行中のジョブには `cancel` を送り、残りの定義は始めない。 */
  isCancelled(): boolean;
}

/** 入力の問題で送らなかった定義の理由（画面が翻訳する）。 */
export const ERR_NO_PAIRS = "no pairs";
export const ERR_DUPLICATE_PREFIX = "duplicate labels: ";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 定義 1 つを実行して、終わりの状態を返す。例外は呼び出し側で `failed` にする。 */
async function runOne(
  e: QueueEntry, ctx: QueueContext, api: QueueApi,
): Promise<Pick<QueueEntry, "state" | "message" | "files">> {
  const spec = e.spec;
  const rows = assignCaseLabels(applyLabelFilter(ctx.baseRows, spec.selection.segmentLabels));
  const dups = duplicateLabels(rows);
  if (dups.length > 0) return { state: "failed", message: `${ERR_DUPLICATE_PREFIX}${dups.join(", ")}`, files: 0 };
  const chosen = selectedPairs(rows);
  if (chosen.length === 0) return { state: "failed", message: ERR_NO_PAIRS, files: 0 };
  const form = applySpecToForm(ctx.baseForm, spec);
  const req = buildBatchRequest(chosen.map((c) => c.pair), form, {
    qc: { smallRoi: spec.qc.smallRoi, lossy: spec.qc.lossy }, acknowledged: [], smallRoiVoxels: spec.qc.smallRoiVoxels, kind: spec.kind,
    recompute: ctx.recompute ?? false,
  });
  let job = await api.submit(req);
  let cancelSent = false;
  while (!BATCH_FINISHED.has(job.state)) {
    if (ctx.isCancelled() && !cancelSent) {
      cancelSent = true;
      job = await api.cancel(job.jobId);
      continue;
    }
    await api.sleep(ctx.pollMs);
    job = await api.get(job.jobId);
  }
  if (job.state === "CANCELLED") return { state: "cancelled", message: null, files: 0 };
  if (job.state === "STOPPED") {
    return job.stopKind === "QC"
      ? { state: "qcStopped", message: job.stopReason, files: 0 }
      : { state: "failed", message: job.stopReason ?? "stopped", files: 0 };
  }
  const results = await api.results(job.jobId);
  const out = buildDatasetOutput(job, results, chosen.map((c) => c.caseLabel), spec, spec.output.prefix, ctx.output);
  if (!out.ok) return { state: "failed", message: out.reason + (out.caseLabel ? `: ${out.caseLabel}` : ""), files: 0 };
  api.save(out.files);
  return { state: "done", message: null, files: out.files.length };
}

/**
 * 有効な定義を順に実行する。`onUpdate` は定義の状態が変わるたびに、その時点の一覧を渡す。
 * 無効の定義・中止後の定義は触らない。
 */
export async function runQueue(
  entries: readonly QueueEntry[], ctx: QueueContext, api: QueueApi, onUpdate: (list: QueueEntry[]) => void,
): Promise<QueueEntry[]> {
  let list = entries.map((e) => (e.enabled ? { ...e, state: "pending" as const, message: null, files: 0 } : e));
  const patch = (id: number, p: Partial<QueueEntry>) => {
    list = list.map((e) => (e.id === id ? { ...e, ...p } : e));
    onUpdate(list);
  };
  onUpdate(list);
  for (const e of entries) {
    if (!e.enabled) continue;
    if (ctx.isCancelled()) break;
    patch(e.id, { state: "running" });
    try {
      patch(e.id, await runOne(e, ctx, api));
    } catch (err) {
      patch(e.id, { state: "failed", message: msg(err), files: 0 });
    }
    // 取り消しは、走っていた定義を `cancelled` にして残りを止める
    if (list.find((x) => x.id === e.id)?.state === "cancelled") break;
  }
  return list;
}

/** 状態ごとの件数（有効な定義だけ）。 */
export function queueSummary(list: readonly QueueEntry[]): Record<QueueState, number> {
  const s: Record<QueueState, number> = { pending: 0, running: 0, done: 0, failed: 0, qcStopped: 0, cancelled: 0 };
  for (const e of list) if (e.enabled) s[e.state]++;
  return s;
}
