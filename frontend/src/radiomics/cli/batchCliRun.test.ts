/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRow } from "../../api";
import type { BatchJobState, BatchPair, BatchPairResult, BatchPairStatusRow, BatchRequest, BatchStatus } from "../batchApi";
import { buildSpec, defaultSpecContent, specText, type SpecContent } from "../batchSpec";
import { VOI_STATS_COLUMNS } from "../datasetCsv";
import {
  EXIT_ATTENTION, EXIT_FAILED, EXIT_OK, EXIT_USAGE, REPORT_FILE, exitCodeOf, runBatchCli, type CliApi, type CliIo, type CliOptions,
  type CliReport,
} from "./batchCliRun";

const pair = (n: number, label: string, over: Partial<BatchPair> = {}): BatchPair => ({
  studyUid: `1.2.${n}`, sourceSeriesUid: `SRC${n}`, maskSeriesUid: `SEG${n}`, segmentNumber: 1, segmentLabel: label,
  maskChannel: 0, status: "AUTO", reason: null, sourceCandidates: [`SRC${n}`], ...over,
});
const needsConfirmation = (n: number, label: string): BatchPair =>
  pair(n, label, { status: "NEEDS_CONFIRMATION", sourceSeriesUid: null, sourceCandidates: [`A${n}`, `B${n}`], reason: "元画像が複数" });
const row = (column: string, value: number): RoiFeatureRow => {
  const us = column.indexOf("_");
  return { column, family: column.slice(0, us), feature: column.slice(us + 1), ibsi: "X", value, notes: [] };
};
const result = (v: number, voi = false): RoiFeatureResult => ({
  radiomicsjVersion: "2.7.0", computedAt: "2026-11-02T00:00:00Z", fromCache: false, label: 1,
  rows: voi ? VOI_STATS_COLUMNS.map((c, i) => row(c, v + i)) : [row("Stat_mean", v), row("Stat_max", v + 1)],
  discretisation: { fixedBinNumber: true, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 },
  provenance: { graphyNextVersion: "0.5.1", radiomicsjVersion: "2.7.0", extractedAt: "2026-11-02T00:00:00.1Z", settingsSha256: "ab".repeat(32) },
  settingsProperties: "INT_binCount=32\n",
  roiSize: { initialVoxels: 100, intensityVoxels: 100, morphVoxels: 100, volumeMm3: 50, smallRoiWarnVoxels: null, smallRoi: null },
  lossyCompressed: false,
});

type Mode = "ok" | "throw" | "qc";

function fake(pairs: BatchPair[], mode: (i: number) => Mode = () => "ok", albums = [{ id: 7, name: "lung" }]) {
  const log = { submits: [] as BatchRequest[], files: new Map<string, string>(), dirs: [] as string[], errors: [] as string[], lines: [] as string[] };
  const jobs = new Map<string, { req: BatchRequest; mode: Mode }>();
  const status = (id: string): BatchStatus => {
    const j = jobs.get(id)!;
    const state: BatchJobState = j.mode === "qc" ? "STOPPED" : "DONE";
    const prs: BatchPairStatusRow[] = j.req.pairs.map((p, index) => ({
      index, pair: p, state: "DONE", failureKind: null, error: null, fromCache: false, elapsedMs: 1, qcFlags: [],
    }));
    return {
      jobId: id, state, elapsedMs: 1, total: prs.length, done: prs.length, failed: 0, skipped: 0, notRun: 0, cancelled: 0,
      stopReason: j.mode === "qc" ? "SMALL_ROI" : null, stopKind: j.mode === "qc" ? "QC" : null, stopIndex: null, pairs: prs,
    };
  };
  const api: CliApi = {
    albums: async () => albums,
    albumStudies: async () => Array.from(new Set(pairs.map((p) => p.studyUid))),
    plan: async () => pairs,
    studies: async (uids) => uids.map((u) => ({ studyInstanceUid: u, patientId: `P-${u}` })),
    async submit(req) {
      const i = log.submits.length;
      log.submits.push(req);
      const m = mode(i);
      if (m === "throw") throw new Error(`submit ${i} rejected`);
      jobs.set(`job${i}`, { req, mode: m });
      return status(`job${i}`);
    },
    get: async (id) => status(id),
    results: async (id) => jobs.get(id)!.req.pairs.map((p, index): BatchPairResult => ({ index, pair: p, result: result(10 + index, jobs.get(id)!.req.kind === "voiStats") })),
    cancel: async (id) => status(id),
  };
  const io: CliIo = {
    readText: (f) => {
      const t = log.files.get(f);
      if (t === undefined) throw new Error("ENOENT");
      return t;
    },
    writeText: (f, t) => void log.files.set(f, t),
    mkdirp: (d) => void log.dirs.push(d),
    join: (d, n) => `${d}/${n}`,
    log: (l) => void log.lines.push(l),
    error: (l) => void log.errors.push(l),
    sleep: async () => undefined,
    now: () => "2026-11-02T00:00:00.000Z",
  };
  return { api, io, log };
}

async function putSpec(log: ReturnType<typeof fake>["log"], file: string, prefix: string, over: Partial<SpecContent> = {}) {
  const spec = await buildSpec({ ...defaultSpecContent(), ...over }, prefix);
  log.files.set(file, specText(spec));
  return spec;
}

const OPTS: CliOptions = { album: "lung", specFiles: [], outDir: "/out", recompute: false, pollMs: 0 };
const pairs = [pair(1, "GTV"), pair(2, "GTV")];

describe("runBatchCli", () => {
  it("複数の定義を順に実行し、定義ごとの 5 ファイルと報告を書く（終了コード 0）", async () => {
    const { api, io, log } = fake(pairs);
    const a = await putSpec(log, "a.json", "ra");
    const b = await putSpec(log, "b.json", "rb", { kind: "voiStats" });
    const r = await runBatchCli({ ...OPTS, specFiles: ["a.json", "b.json"] }, api, io);
    expect(r.report.specs.map((x) => [x.state, x.message])).toEqual([["done", null], ["done", null]]);
    expect(r.code).toBe(EXIT_OK);
    expect(log.submits.map((s) => s.kind)).toEqual([null, "voiStats"]);
    for (const base of ["ra", "rb"]) {
      for (const suffix of [".csv", "_definitions.csv", "_radiomicsj.properties", "_spec.json", "_subjects_private.csv"]) {
        expect(log.files.has(`/out/${base}${suffix}`), `${base}${suffix}`).toBe(true);
      }
    }
    expect(log.files.get("/out/ra.csv")).toContain(a.sha256);
    expect(log.files.get("/out/rb.csv")).toContain(b.sha256);
    const report = JSON.parse(log.files.get(`/out/${REPORT_FILE}`)!) as CliReport;
    expect(report.exitCode).toBe(0);
    expect(report.album).toEqual({ id: 7, name: "lung" });
    expect(report.specs.map((s) => [s.prefix, s.state, s.files.length, s.sha256])).toEqual([["ra", "done", 5, a.sha256], ["rb", "done", 5, b.sha256]]);
    // 患者 ID は、被験者の対応表（_subjects_private.csv。画面の既定どおり別ファイル）にだけ入る。表・報告には入らない
    const withPid = [...log.files.entries()].filter(([, t]) => t.includes("P-1.2.1")).map(([k]) => k).sort();
    expect(withPid).toEqual(["/out/ra_subjects_private.csv", "/out/rb_subjects_private.csv"]);
  });

  it("失敗した定義があっても残りは続け、終了コードは 1", async () => {
    const { api, io, log } = fake(pairs, (i) => (i === 1 ? "throw" : "ok"));
    await putSpec(log, "a.json", "ra");
    await putSpec(log, "b.json", "rb");
    await putSpec(log, "c.json", "rc");
    const r = await runBatchCli({ ...OPTS, specFiles: ["a.json", "b.json", "c.json"] }, api, io);
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.report.specs.map((s) => s.state)).toEqual(["done", "failed", "done"]);
    expect(r.report.specs[1].message).toBe("submit 1 rejected");
    expect(log.files.has("/out/ra.csv") && log.files.has("/out/rc.csv")).toBe(true);
    expect(log.files.has("/out/rb.csv")).toBe(false);
  });

  it("QC で止まった定義だけがあれば終了コード 2（表は書かない）", async () => {
    const { api, io, log } = fake(pairs, () => "qc");
    await putSpec(log, "a.json", "ra", { qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: 5 } });
    const r = await runBatchCli({ ...OPTS, specFiles: ["a.json"] }, api, io);
    expect(r.code).toBe(EXIT_ATTENTION);
    expect(r.report.specs[0].state).toBe("qcStopped");
    expect(log.files.has("/out/ra.csv")).toBe(false);
  });

  it("確認待ちの組は実行せず報告し、終了コード 2。失敗があれば 1 が優先する", async () => {
    const mixed = [pair(1, "GTV"), needsConfirmation(2, "GTV")];
    const { api, io, log } = fake(mixed);
    await putSpec(log, "a.json", "ra");
    const r = await runBatchCli({ ...OPTS, specFiles: ["a.json"] }, api, io);
    expect(r.code).toBe(EXIT_ATTENTION);
    expect(log.submits[0].pairs).toHaveLength(1);
    expect(r.report.specs[0].state).toBe("done");
    expect(r.report.specs[0].unconfirmedPairs).toEqual([{ studyUid: "1.2.2", maskSeriesUid: "SEG2", segmentLabel: "GTV", reason: "元画像が複数" }]);

    // 対象の組が確認待ちだけ → 失敗ではなく要確認
    const only = fake([needsConfirmation(1, "GTV")]);
    await putSpec(only.log, "a.json", "ra");
    const r2 = await runBatchCli({ ...OPTS, specFiles: ["a.json"] }, only.api, only.io);
    expect(r2.code).toBe(EXIT_ATTENTION);
    expect(r2.report.specs[0].state).toBe("attention");
    expect(only.log.submits).toHaveLength(0);

    // 絞り込みで外れた確認待ちの組は数えない
    const filtered = fake([pair(1, "GTV"), needsConfirmation(2, "Lung")]);
    await putSpec(filtered.log, "a.json", "ra", { selection: { segmentLabels: ["GTV"] } });
    expect((await runBatchCli({ ...OPTS, specFiles: ["a.json"] }, filtered.api, filtered.io)).code).toBe(EXIT_OK);
  });

  it("SHA-256 が合わない定義が 1 つでもあれば、何も送らず何も書かず終了コード 3", async () => {
    const { api, io, log } = fake(pairs);
    await putSpec(log, "a.json", "ra");
    const bad = JSON.parse(log.files.get("a.json")!) as { form: { binCount: number } };
    bad.form.binCount += 1;
    log.files.set("bad.json", JSON.stringify(bad));
    const r = await runBatchCli({ ...OPTS, specFiles: ["a.json", "bad.json"] }, api, io);
    expect(r.code).toBe(EXIT_USAGE);
    expect(log.submits).toHaveLength(0);
    expect(log.dirs).toHaveLength(0);
    expect([...log.files.keys()].filter((k) => k.startsWith("/out"))).toEqual([]);
    expect(log.errors.join("\n")).toContain("sha_mismatch");
  });

  it("読めない定義・同じ接頭辞の定義・定義なしは終了コード 3", async () => {
    const { api, io, log } = fake(pairs);
    await putSpec(log, "a.json", "same");
    await putSpec(log, "b.json", "same", { qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: 3 } });
    expect((await runBatchCli({ ...OPTS, specFiles: ["a.json", "missing.json"] }, api, io)).code).toBe(EXIT_USAGE);
    const dup = await runBatchCli({ ...OPTS, specFiles: ["a.json", "b.json"] }, api, io);
    expect(dup.code).toBe(EXIT_USAGE);
    expect(log.errors.join("\n")).toContain("同じです");
    expect((await runBatchCli({ ...OPTS, specFiles: [] }, api, io)).code).toBe(EXIT_USAGE);
    expect(log.submits).toHaveLength(0);
  });

  it("アルバムは名前または ID で引く。無い・曖昧は終了コード 3", async () => {
    const albums = [{ id: 7, name: "lung" }, { id: 8, name: "dup" }, { id: 9, name: "dup" }];
    const { api, io, log } = fake(pairs, () => "ok", albums);
    await putSpec(log, "a.json", "ra");
    const run = (album: string) => runBatchCli({ ...OPTS, album, specFiles: ["a.json"] }, api, io);
    expect((await run("lung")).report.album?.id).toBe(7);
    expect((await run("8")).report.album?.name).toBe("dup");
    expect((await run("none")).code).toBe(EXIT_USAGE);
    expect((await run("dup")).code).toBe(EXIT_USAGE);
    expect(log.errors.join("\n")).toContain("8, 9");
  });

  it("--recompute が要求に載る", async () => {
    const { api, io, log } = fake(pairs);
    await putSpec(log, "a.json", "ra");
    await runBatchCli({ ...OPTS, specFiles: ["a.json"], recompute: true }, api, io);
    await runBatchCli({ ...OPTS, specFiles: ["a.json"], recompute: false }, api, io);
    expect(log.submits.map((s) => s.recompute)).toEqual([true, false]);
  });
});

describe("exitCodeOf", () => {
  it("失敗 → 要確認 → 成功の順に優先する", () => {
    expect(exitCodeOf(["done", "done"])).toBe(0);
    expect(exitCodeOf([])).toBe(0);
    expect(exitCodeOf(["done", "qcStopped"])).toBe(2);
    expect(exitCodeOf(["cancelled"])).toBe(2);
    expect(exitCodeOf(["attention", "done"])).toBe(2);
    expect(exitCodeOf(["failed", "done"])).toBe(1);
    expect(exitCodeOf(["qcStopped", "failed", "attention"])).toBe(1);
  });
});
