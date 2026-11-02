/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRow } from "../api";
import type { BatchJobState, BatchPair, BatchPairResult, BatchPairStatusRow, BatchRequest, BatchStatus } from "./batchApi";
import { initialRows, selectedPairs, assignCaseLabels } from "./batchPairs";
import {
  buildDatasetOutput, queueSummary, runQueue, type OutputContext, type QueueApi, type QueueContext, type QueueEntry,
} from "./batchQueue";
import { buildSpec, defaultSpecContent, type BatchSpec, type SpecContent } from "./batchSpec";
import { assignSubjectCodes } from "./datasetCsv";
import { defaultRoiFeatureForm } from "./roiFeatureSettings";

const pair = (n: number, label: string): BatchPair => ({
  studyUid: `1.2.${n}`, sourceSeriesUid: `SRC${n}`, maskSeriesUid: `SEG${n}`, segmentNumber: 1, segmentLabel: label,
  maskChannel: 0, status: "AUTO", reason: null, sourceCandidates: [`SRC${n}`],
});
const row = (column: string, value: number): RoiFeatureRow => {
  const us = column.indexOf("_");
  return { column, family: column.slice(0, us), feature: column.slice(us + 1), ibsi: "X", value, notes: [] };
};
const result = (v: number): RoiFeatureResult => ({
  radiomicsjVersion: "2.7.0", computedAt: "2026-11-02T00:00:00Z", fromCache: false, label: 1,
  rows: [row("Stat_mean", v), row("Stat_max", v + 1)],
  discretisation: { fixedBinNumber: true, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 },
  provenance: { graphyNextVersion: "0.5.1", radiomicsjVersion: "2.7.0", extractedAt: "2026-11-02T00:00:00.1Z", settingsSha256: "ab".repeat(32) },
  settingsProperties: "INT_binCount=32\n",
  roiSize: { initialVoxels: 100, intensityVoxels: 100, morphVoxels: 100, volumeMm3: 50, smallRoiWarnVoxels: null, smallRoi: null },
  lossyCompressed: false,
});

const pairs = [pair(1, "GTV"), pair(2, "GTV"), pair(3, "Lung")];
const baseRows = initialRows(pairs);
const OUT: OutputContext = {
  albumName: "lung", subjects: assignSubjectCodes(["1.2.1", "1.2.2", "1.2.3"], () => undefined, ["1.2.1", "1.2.2", "1.2.3"]),
  includePatientId: false, subjectsFile: true, bom: false,
};

async function spec(prefix: string, over: Partial<SpecContent> = {}): Promise<BatchSpec> {
  return buildSpec({ ...defaultSpecContent(), ...over }, prefix);
}
const entry = (id: number, s: BatchSpec, enabled = true): QueueEntry => ({ id, spec: s, enabled, state: "pending", message: null, files: 0 });

/** 注入する API の偽物。定義ごとの振る舞いは送信の順番（0 始まり）で指定する。 */
function fakeApi(behaviour: (submitIndex: number, req: BatchRequest) => "ok" | "throw" | "qc" | "env" | "hang") {
  const log = { submits: [] as BatchRequest[], saved: [] as string[][], cancels: 0 };
  const jobs = new Map<string, { req: BatchRequest; mode: ReturnType<typeof behaviour>; polls: number }>();
  const statusOf = (id: string): BatchStatus => {
    const j = jobs.get(id)!;
    const finished = j.mode !== "hang" || log.cancels > 0;
    let state: BatchJobState = j.polls >= 1 && finished ? "DONE" : "RUNNING";
    let stopKind: BatchStatus["stopKind"] = null;
    let stopReason: string | null = null;
    if (state === "DONE" && j.mode === "qc") { state = "STOPPED"; stopKind = "QC"; stopReason = "SMALL_ROI"; }
    if (state === "DONE" && j.mode === "env") { state = "STOPPED"; stopKind = "ENVIRONMENT"; stopReason = "disk full"; }
    if (state === "DONE" && j.mode === "hang") state = "CANCELLED";
    const prs: BatchPairStatusRow[] = j.req.pairs.map((p, index) => ({
      index, pair: p, state: "DONE", failureKind: null, error: null, fromCache: false, elapsedMs: 1, qcFlags: [],
    }));
    return {
      jobId: id, state, elapsedMs: 1, total: prs.length, done: prs.length, failed: 0, skipped: 0, notRun: 0, cancelled: 0,
      stopReason, stopKind, stopIndex: null, pairs: prs,
    };
  };
  const api: QueueApi = {
    async submit(req) {
      const i = log.submits.length;
      log.submits.push(req);
      const mode = behaviour(i, req);
      if (mode === "throw") throw new Error(`submit ${i} rejected`);
      const id = `job${i}`;
      jobs.set(id, { req, mode, polls: 0 });
      return statusOf(id);
    },
    async get(id) { jobs.get(id)!.polls++; return statusOf(id); },
    async results(id) {
      return jobs.get(id)!.req.pairs.map((p, index): BatchPairResult => ({ index, pair: p, result: result(10 + index) }));
    },
    async cancel(id) { log.cancels++; jobs.get(id)!.polls++; return statusOf(id); },
    save(files) { log.saved.push(files.map((f) => f.name)); },
    sleep: async () => undefined,
  };
  return { api, log };
}

const ctx = (over: Partial<QueueContext> = {}): QueueContext => ({
  baseRows, baseForm: defaultRoiFeatureForm(), output: OUT, pollMs: 0, isCancelled: () => false, ...over,
});

describe("runQueue", () => {
  it("1 つの定義の失敗で残りを止めず、定義ごとに表を書き出す", async () => {
    const a = await spec("a");
    const b = await spec("b", { qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: 5 } });
    const c = await spec("c");
    const { api, log } = fakeApi((i) => (i === 1 ? "throw" : "ok"));
    const updates: QueueEntry[][] = [];
    const final = await runQueue([entry(1, a), entry(2, b), entry(3, c)], ctx(), api, (l) => updates.push(l));
    expect(final.map((e) => e.state)).toEqual(["done", "failed", "done"]);
    expect(final[1].message).toBe("submit 1 rejected");
    expect(log.submits).toHaveLength(3);
    expect(log.saved.map((f) => f.filter((n) => n.endsWith(".csv") && !n.includes("_")))).toEqual([["a.csv"], ["c.csv"]]);
    expect(final[0].files).toBe(5);
    expect(updates.some((l) => l.some((e) => e.state === "running"))).toBe(true);
  });

  it("各定義の設定（QC・基準値・種類）を要求に載せる", async () => {
    const a = await spec("a", { kind: "voiStats" });
    const b = await spec("b", { qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: 7 } });
    const { api, log } = fakeApi(() => "ok");
    await runQueue([entry(1, a), entry(2, b)], ctx(), api, () => undefined);
    expect(log.submits[0].kind).toBe("voiStats");
    expect(log.submits[1].kind).toBeNull();
    expect(log.submits[1].qc).toEqual({ smallRoi: "STOP", lossy: "FLAG" });
    expect(log.submits[1].smallRoiWarnVoxels).toBe(7);
  });

  it("QC で止まった定義は表を書かず、次へ進む。環境の停止は失敗にして次へ進む", async () => {
    const { api, log } = fakeApi((i) => (i === 0 ? "qc" : i === 1 ? "env" : "ok"));
    const final = await runQueue(
      [entry(1, await spec("a")), entry(2, await spec("b")), entry(3, await spec("c"))], ctx(), api, () => undefined,
    );
    expect(final.map((e) => e.state)).toEqual(["qcStopped", "failed", "done"]);
    expect(final[0].message).toBe("SMALL_ROI");
    expect(final[1].message).toBe("disk full");
    expect(log.saved).toHaveLength(1);
  });

  it("無効の定義は送らず、状態も変えない", async () => {
    const { api, log } = fakeApi(() => "ok");
    const final = await runQueue([entry(1, await spec("a"), false), entry(2, await spec("b"))], ctx(), api, () => undefined);
    expect(log.submits).toHaveLength(1);
    expect(final.map((e) => e.state)).toEqual(["pending", "done"]);
    expect(queueSummary(final)).toMatchObject({ done: 1, pending: 0 });
  });

  it("セグメント名の絞り込みで対象が 0 件なら、その定義だけ失敗にして送らない", async () => {
    const none = await spec("none", { selection: { segmentLabels: ["Nothing"] } });
    const gtv = await spec("gtv", { selection: { segmentLabels: ["gtv"] } });
    const { api, log } = fakeApi(() => "ok");
    const final = await runQueue([entry(1, none), entry(2, gtv)], ctx(), api, () => undefined);
    expect(final.map((e) => e.state)).toEqual(["failed", "done"]);
    expect(final[0].message).toBe("no pairs");
    expect(log.submits).toHaveLength(1);
    expect(log.submits[0].pairs.map((p) => p.segmentLabel)).toEqual(["GTV", "GTV"]);
  });

  it("中止すると、走っているジョブに取り消しを送り、残りの定義は始めない", async () => {
    let stop = false;
    const { api, log } = fakeApi(() => "hang");
    const base = ctx({ isCancelled: () => stop });
    const p = runQueue([entry(1, await spec("a")), entry(2, await spec("b"))], base, { ...api, sleep: async () => { stop = true; } }, () => undefined);
    const final = await p;
    expect(final.map((e) => e.state)).toEqual(["cancelled", "pending"]);
    expect(log.cancels).toBe(1);
    expect(log.submits).toHaveLength(1);
    expect(log.saved).toHaveLength(0);
  });

  it("一覧で作った表は、同じ定義・同じ結果の単独実行の書き出しと一致する", async () => {
    const a = await spec("same");
    const { api, log } = fakeApi(() => "ok");
    const saved: { name: string; text: string }[] = [];
    await runQueue([entry(1, a)], ctx(), { ...api, save: (fs) => saved.push(...fs) }, () => undefined);
    // 単独実行の経路（画面の write()）が呼ぶ関数に、同じ組・同じ結果を渡す
    const chosen = selectedPairs(assignCaseLabels(baseRows));
    const job = (await api.get("job0"));
    const direct = buildDatasetOutput(
      job, log.submits[0].pairs.map((p, index) => ({ index, pair: p, result: result(10 + index) })),
      chosen.map((c) => c.caseLabel), a, "same", OUT,
    );
    if (!direct.ok) throw new Error("direct output failed");
    expect(saved.map((f) => f.name)).toEqual(direct.files.map((f) => f.name));
    expect(saved.map((f) => f.text)).toEqual(direct.files.map((f) => f.text));
    expect(saved[0].text).toContain(a.sha256);
  });
});
