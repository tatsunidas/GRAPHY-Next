/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 一括抽出の無人実行（コマンドライン）の本体。画面は使わず、起動済みの backend に対して、保存した定義（複数）を
 * 上から順に実行し、定義ごとに表を書き、報告 JSON と終了コードを返す。
 *
 * <p>画面の「定義の一覧」と同じ部品（`runQueue`・`parseSpec`・`buildDatasetOutput`）を通すので、同じ定義・同じ組なら
 * 画面と同じ表になる。`fetch`・ファイルの読み書きは注入する（テスト用。本番は `batchCliMain.ts`）。
 *
 * <p>終了コード: 0＝全定義が完了／1＝いずれかの定義が失敗／2＝失敗は無いが QC 停止・取り消し・確認待ちの組があった／
 * 3＝引数・定義の誤り（1 つでも不正なら何も実行しない）。4（backend の起動・接続の失敗）と 5（DB の使用中）は
 * 起動側（`desktop/batchCli.js`）が返す。優先は 3 → 1 → 2 → 0。
 */
import type { BatchPair, BatchPairResult, BatchRequest, BatchStatus } from "../batchApi";
import { applyLabelFilter, initialRows, type PairRow } from "../batchPairs";
import { ERR_NO_PAIRS, runQueue, type QueueEntry, type QueueState } from "../batchQueue";
import { parseSpec, type BatchSpec } from "../batchSpec";
import { assignSubjectCodes, type OutputFile } from "../datasetCsv";
import { defaultRoiFeatureForm } from "../roiFeatureSettings";
import { batchFileBase } from "../batchPairs";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ATTENTION = 2;
export const EXIT_USAGE = 3;

export const REPORT_FILE = "batch-cli-report.json";

export interface CliOptions {
  /** アルバムの名前または ID。 */
  album: string;
  /** 定義ファイル。上から順に実行する。 */
  specFiles: string[];
  outDir: string;
  recompute: boolean;
  /** 報告 JSON の場所。省略は `<outDir>/batch-cli-report.json`。 */
  reportFile?: string;
  pollMs?: number;
}

export interface CliApi {
  albums(): Promise<{ id: number; name: string }[]>;
  albumStudies(albumId: number): Promise<string[]>;
  plan(albumId: number): Promise<BatchPair[]>;
  studies(uids: string[]): Promise<{ studyInstanceUid: string; patientId: string | null }[]>;
  submit(req: BatchRequest): Promise<BatchStatus>;
  get(jobId: string): Promise<BatchStatus>;
  results(jobId: string): Promise<BatchPairResult[]>;
  cancel(jobId: string): Promise<BatchStatus>;
}

export interface CliIo {
  readText(file: string): string;
  writeText(file: string, text: string): void;
  mkdirp(dir: string): void;
  join(dir: string, name: string): string;
  /** 進み具合（標準出力）。 */
  log(line: string): void;
  /** 誤り（標準エラー）。 */
  error(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): string;
}

export interface UnconfirmedPair {
  studyUid: string;
  maskSeriesUid: string;
  segmentLabel: string | null;
  reason: string | null;
}

export type SpecOutcome = QueueState | "attention";

export interface SpecReport {
  file: string;
  prefix: string;
  sha256: string;
  kind: string;
  state: SpecOutcome;
  message: string | null;
  files: string[];
  /** 無人では元画像を選べないので実行しなかった組。 */
  unconfirmedPairs: UnconfirmedPair[];
}

export interface CliReport {
  tool: "graphy-batch";
  startedAt: string;
  finishedAt: string;
  album: { id: number; name: string } | null;
  recompute: boolean;
  exitCode: number;
  specs: SpecReport[];
  errors: string[];
}

export interface CliResult {
  code: number;
  report: CliReport;
}

interface LoadedSpec {
  file: string;
  spec: BatchSpec;
}

/** 終了コードの集計（実行前の誤りは呼び出し側が 3 で返す）。失敗 → 要確認 → 成功の順で優先する。 */
export function exitCodeOf(outcomes: readonly SpecOutcome[]): number {
  if (outcomes.includes("failed") || outcomes.includes("running") || outcomes.includes("pending")) return EXIT_FAILED;
  if (outcomes.some((o) => o === "qcStopped" || o === "cancelled" || o === "attention")) return EXIT_ATTENTION;
  return EXIT_OK;
}

function unconfirmedOf(rows: readonly PairRow[], labels: readonly string[]): UnconfirmedPair[] {
  return applyLabelFilter(rows, labels)
    .filter((r) => r.pair.status === "NEEDS_CONFIRMATION" && !r.filteredOut && r.source == null)
    .map((r) => ({
      studyUid: r.pair.studyUid, maskSeriesUid: r.pair.maskSeriesUid, segmentLabel: r.pair.segmentLabel, reason: r.pair.reason,
    }));
}

export async function runBatchCli(opts: CliOptions, api: CliApi, io: CliIo): Promise<CliResult> {
  const startedAt = io.now();
  const errors: string[] = [];
  const usage = (message: string): CliResult => {
    io.error(message);
    errors.push(message);
    // 実行前の誤りでは何も書かない（報告も書かない）
    return {
      code: EXIT_USAGE,
      report: { tool: "graphy-batch", startedAt, finishedAt: io.now(), album: null, recompute: opts.recompute, exitCode: EXIT_USAGE, specs: [], errors },
    };
  };

  if (opts.specFiles.length === 0) return usage("定義（--spec）が 1 つも指定されていません");

  // 1. 定義をすべて読む。1 つでも不正なら何も実行しない
  const loaded: LoadedSpec[] = [];
  const problems: string[] = [];
  for (const file of opts.specFiles) {
    let text: string;
    try {
      text = io.readText(file);
    } catch (e) {
      problems.push(`${file}: 読めません（${e instanceof Error ? e.message : String(e)}）`);
      continue;
    }
    const r = await parseSpec(text);
    if (!r.ok) problems.push(`${file}: 定義が不正です（${r.error}${r.detail ? ` ${r.detail}` : ""}）`);
    else loaded.push({ file, spec: r.spec });
  }
  // 同じ接頭辞の定義は互いのファイルを上書きするので、実行前に断る
  const byBase = new Map<string, string>();
  for (const l of loaded) {
    const base = batchFileBase(l.spec.output.prefix);
    const other = byBase.get(base);
    if (other) problems.push(`${l.file}: 出力の接頭辞 "${base}" が ${other} と同じです（ファイルを上書きし合います）`);
    else byBase.set(base, l.file);
  }
  if (problems.length > 0) {
    for (const p of problems) io.error(p);
    errors.push(...problems);
    return { code: EXIT_USAGE, report: { tool: "graphy-batch", startedAt, finishedAt: io.now(), album: null, recompute: opts.recompute, exitCode: EXIT_USAGE, specs: [], errors } };
  }

  // 2. アルバム（名前または ID。曖昧・無しは断る）
  const albums = await api.albums();
  const byId = /^\d+$/.test(opts.album) ? albums.filter((a) => a.id === Number(opts.album)) : [];
  const matches = byId.length > 0 ? byId : albums.filter((a) => a.name === opts.album);
  if (matches.length === 0) return usage(`アルバム「${opts.album}」がありません`);
  if (matches.length > 1) return usage(`アルバム「${opts.album}」が複数あります（ID で指定してください: ${matches.map((a) => a.id).join(", ")}）`);
  const album = matches[0];

  // 3. 組の候補と被験者コード
  const uids = await api.albumStudies(album.id);
  const pairs = await api.plan(album.id);
  const rows = initialRows(pairs);
  const studyUids = Array.from(new Set(pairs.map((p) => p.studyUid)));
  const studies = studyUids.length === 0 ? [] : await api.studies(studyUids);
  const patientOf = new Map(studies.map((s) => [s.studyInstanceUid, s.patientId]));
  const subjects = assignSubjectCodes(uids, (u) => patientOf.get(u), studyUids);

  io.mkdirp(opts.outDir);
  const written = new Map<number, string[]>();
  const entries: QueueEntry[] = loaded.map((l, i) => ({ id: i + 1, spec: l.spec, enabled: true, state: "pending", message: null, files: 0 }));
  const final = await runQueue(entries, {
    baseRows: rows, baseForm: defaultRoiFeatureForm(),
    output: { albumName: album.name, subjects, includePatientId: false, subjectsFile: true, bom: false },
    pollMs: opts.pollMs ?? 1000, isCancelled: () => false, recompute: opts.recompute,
  }, {
    submit: api.submit, get: api.get, results: api.results, cancel: api.cancel,
    save: (files: readonly OutputFile[]) => {
      // `runQueue` は定義ごとに 1 回だけ呼ぶ。呼ばれた順が定義の順（直列）なので、最後に更新された定義に紐づける
      const names: string[] = [];
      for (const f of files) {
        io.writeText(io.join(opts.outDir, f.name), f.text);
        names.push(f.name);
      }
      written.set(written.size + 1, names);
    },
    sleep: io.sleep,
  }, (list) => {
    const running = list.find((e) => e.state === "running");
    if (running) io.log(`[${running.id}/${list.length}] ${running.spec.output.prefix || "roi-features-batch"} を実行中…`);
  });

  // 完了した定義の順に書いたファイルを割り当てる（失敗・停止は書かない）
  let doneIndex = 0;
  const specs: SpecReport[] = final.map((e, i) => {
    const unconfirmed = unconfirmedOf(rows, e.spec.selection.segmentLabels);
    // 対象の組が確認待ちだけで 0 件になった定義は、失敗ではなく「要確認」
    const attention = e.state === "failed" && e.message === ERR_NO_PAIRS && unconfirmed.length > 0;
    const files = e.state === "done" ? (written.get(++doneIndex) ?? []) : [];
    return {
      file: loaded[i].file, prefix: e.spec.output.prefix, sha256: e.spec.sha256, kind: e.spec.kind,
      state: attention ? "attention" : e.state, message: e.message, files, unconfirmedPairs: unconfirmed,
    };
  });
  const outcomes = specs.map((s) => (s.state === "done" && s.unconfirmedPairs.length > 0 ? ("attention" as const) : s.state));
  const code = exitCodeOf(outcomes);
  const report: CliReport = {
    tool: "graphy-batch", startedAt, finishedAt: io.now(), album, recompute: opts.recompute, exitCode: code, specs, errors,
  };
  io.writeText(opts.reportFile ?? io.join(opts.outDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  for (const s of specs) {
    io.log(`${s.file}: ${s.state}${s.message ? ` (${s.message})` : ""}${s.unconfirmedPairs.length > 0 ? ` — 確認待ちの組 ${s.unconfirmedPairs.length} 件は実行していません` : ""}`);
  }
  io.log(`終了コード ${code}`);
  return { code, report };
}
