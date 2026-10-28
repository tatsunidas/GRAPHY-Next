/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRow } from "../api";
import type { BatchPair, BatchPairStatusRow } from "./batchApi";
import {
  applyLabelFilter,
  assignCaseLabels,
  batchFileBase,
  batchFiles,
  buildBatchRequest,
  duplicateLabels,
  initialRows,
  pairsCsv,
  selectedPairs,
  setIncluded,
  setSource,
  smallRoiThresholdUnset,
  stackedDataCsv,
  summarize,
} from "./batchPairs";
import { roiFeatureDataCsv } from "./roiFeatureCsv";
import { defaultRoiFeatureForm } from "./roiFeatureSettings";

const pair = (over: Partial<BatchPair> = {}): BatchPair => ({
  studyUid: "1.2.3", sourceSeriesUid: "SRC", maskSeriesUid: "SEG", segmentNumber: 1, segmentLabel: "GTV",
  maskChannel: 0, status: "AUTO", reason: null, sourceCandidates: ["SRC"], ...over,
});
const needs = (over: Partial<BatchPair> = {}) =>
  pair({ status: "NEEDS_CONFIRMATION", sourceSeriesUid: null, sourceCandidates: ["A", "B"], ...over });
const excluded = (over: Partial<BatchPair> = {}) =>
  pair({ status: "EXCLUDED", sourceSeriesUid: null, sourceCandidates: [], reason: "マスクが空", ...over });

const row = (column: string, value: number | null): RoiFeatureRow => {
  const us = column.indexOf("_");
  return { column, family: column.slice(0, us), feature: column.slice(us + 1), ibsi: "X", value, notes: [] };
};
const result = (values: number[], columns = ["Stat_mean", "Stat_max"]): RoiFeatureResult => ({
  radiomicsjVersion: "2.5.2", computedAt: "2026-10-28T00:00:00Z", fromCache: false, label: 1,
  rows: columns.map((c, i) => row(c, values[i] ?? null)),
  discretisation: { fixedBinNumber: true, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 },
  provenance: {
    graphyNextVersion: "0.5.0", radiomicsjVersion: "2.5.2", extractedAt: "2026-10-28T00:00:00.1Z",
    settingsSha256: "ab".repeat(32),
  },
  settingsProperties: "INT_binCount=32\n",
  roiSize: {
    initialVoxels: 100, intensityVoxels: 100, morphVoxels: 100, volumeMm3: 50,
    smallRoiWarnVoxels: null, smallRoi: null,
  },
  lossyCompressed: false,
});

describe("initialRows / selection", () => {
  it("AUTO is included, needs-confirmation is not until a source is chosen, excluded never is", () => {
    const rows = initialRows([pair(), needs(), excluded()]);
    expect(rows.map((r) => r.included)).toEqual([true, false, false]);
    expect(summarize(rows)).toEqual({ auto: 1, needsConfirmation: 1, excluded: 1, selected: 1, needsUnchosen: 1 });
  });

  it("an unconfirmed pair is never sent", () => {
    const rows = initialRows([needs()]);
    // 外から強制的に対象にしても、元画像が無ければ送らない
    const forced = rows.map((r) => ({ ...r, included: true }));
    expect(selectedPairs(forced)).toEqual([]);
    expect(setIncluded(rows, 0, true)[0].included).toBe(false);
  });

  it("choosing a source includes the pair and sends the chosen source; unchoosing removes it", () => {
    let rows = initialRows([needs()]);
    rows = setSource(rows, 0, "B");
    expect(rows[0].included).toBe(true);
    expect(selectedPairs(rows)[0].pair.sourceSeriesUid).toBe("B");
    rows = setSource(rows, 0, null);
    expect(rows[0].included).toBe(false);
    expect(selectedPairs(rows)).toEqual([]);
  });

  it("a source outside the candidates is refused", () => {
    const rows = setSource(initialRows([needs()]), 0, "NOT-A-CANDIDATE");
    expect(rows[0].source).toBeNull();
    expect(rows[0].included).toBe(false);
  });

  it("an excluded pair can be neither chosen nor included", () => {
    let rows = initialRows([excluded()]);
    rows = setSource(rows, 0, "SRC");
    rows = setIncluded(rows, 0, true);
    expect(rows[0].included).toBe(false);
    expect(selectedPairs(rows)).toEqual([]);
  });

  it("the order of selectedPairs is the order of the server-side result index", () => {
    const rows = initialRows([pair({ studyUid: "a" }), excluded(), pair({ studyUid: "b" })]);
    expect(selectedPairs(rows).map((s) => s.pair.studyUid)).toEqual(["a", "b"]);
  });
});

describe("case labels", () => {
  it("numbers only the included pairs, keeps what the user typed, and pads", () => {
    let rows = initialRows([pair(), excluded(), pair({ studyUid: "x" }), pair({ studyUid: "y" })]);
    rows[3] = { ...rows[3], caseLabel: "mine" };
    rows = assignCaseLabels(rows);
    expect(rows.map((r) => r.caseLabel)).toEqual(["C001", "", "C002", "mine"]);
  });

  it("a pair that becomes included later gets an unused label, not a positional one (no collision)", () => {
    // 試行で C001..C003 が振られた後、2 番目の要確認の組を選んで対象に加える
    let rows = initialRows([pair(), needs(), pair({ studyUid: "x" }), pair({ studyUid: "y" })]);
    rows = assignCaseLabels(rows);
    expect(rows.map((r) => r.caseLabel)).toEqual(["C001", "", "C002", "C003"]);
    rows = setSource(rows, 1, "A");
    rows = assignCaseLabels(rows);
    expect(rows.map((r) => r.caseLabel)).toEqual(["C001", "C004", "C002", "C003"]);
    expect(duplicateLabels(rows)).toEqual([]);
  });

  it("assigning twice changes nothing", () => {
    const once = assignCaseLabels(initialRows([pair(), pair({ studyUid: "x" })]));
    expect(assignCaseLabels(once)).toEqual(once);
  });

  it("detects duplicates among included pairs only", () => {
    let rows = initialRows([pair(), pair({ studyUid: "x" }), excluded()]);
    rows = rows.map((r) => ({ ...r, caseLabel: "same" }));
    expect(duplicateLabels(rows)).toEqual(["same"]);
  });

  it("a newline in a label cannot break a CSV row", () => {
    const rows = initialRows([pair()]).map((r) => ({ ...r, caseLabel: "a\r\nb" }));
    expect(selectedPairs(rows)[0].caseLabel).toBe("a b");
  });
});

describe("buildBatchRequest", () => {
  it("is 3D only, no scales, C/T 0 — even when LoG is on in the form", () => {
    const form = { ...defaultRoiFeatureForm(), logOn: true, logByRadius: true, scalesText: "0,2,3" };
    const req = buildBatchRequest([pair()], form);
    expect(req.roiModes).toEqual(["WHOLE_3D"]);
    expect(req.scales).toBeNull();
    expect(req.channel).toBe(0);
    expect(req.timePoint).toBe(0);
    expect(Object.keys(req.settings).filter((k) => /logSigma|logTruncate|logPadding/.test(k))).toEqual([]);
    expect(req.settings.INT_binCount).toBe("32");
  });
});

describe("stackedDataCsv", () => {
  it("each line equals the single-case row of the existing exporter (old path vs new path)", () => {
    const a = result([1.5, 9]);
    const b = result([2.5, 7]);
    const out = stackedDataCsv([{ caseLabel: "C001", result: a }, { caseLabel: "C002", result: b }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const single = (r: RoiFeatureResult, l: string) => roiFeatureDataCsv(r, l).split("\r\n");
    const lines = out.csv.split("\r\n");
    expect(lines[0]).toBe(single(a, "C001")[0]);
    expect(lines[1]).toBe(single(a, "C001")[1]);
    expect(lines[2]).toBe(single(b, "C002")[1]);
    expect(lines.length).toBe(4); // 見出し + 2 行 + 末尾の空
  });

  it("refuses to stack when the columns differ, naming the case", () => {
    const out = stackedDataCsv([
      { caseLabel: "C001", result: result([1, 2]) },
      { caseLabel: "C002", result: result([1, 2], ["Stat_mean", "Other_x"]) },
    ]);
    expect(out).toEqual({ ok: false, reason: "header mismatch", caseLabel: "C002" });
  });

  it("refuses an empty input", () => {
    expect(stackedDataCsv([]).ok).toBe(false);
  });
});

describe("pairsCsv / batchFiles", () => {
  const status = (p: BatchPair, over: Partial<BatchPairStatusRow> = {}): BatchPairStatusRow => ({
    index: 0, pair: p, state: "DONE", failureKind: null, error: null, fromCache: false, elapsedMs: 5, qcFlags: [], ...over,
  });

  it("carries UIDs and labels but never a patient name or ID", () => {
    // 画面の確認表だけが持つ患者情報を、関数の入力に混ぜても出力に出ない
    const display = { patientName: "YAMADA^TARO", patientId: "PID-0001" };
    const csv = pairsCsv([{ caseLabel: "C001", status: status(pair()) }]);
    expect(csv).toContain("1.2.3");
    expect(csv).toContain("C001");
    expect(csv).not.toContain(display.patientName);
    expect(csv).not.toContain(display.patientId);
  });

  it("keeps failed and not-run pairs in the map with their state", () => {
    const csv = pairsCsv([
      { caseLabel: "C001", status: status(pair()) },
      { caseLabel: "C002", status: status(pair(), { state: "FAILED", failureKind: "INPUT", error: "ROI が空です" }) },
      { caseLabel: "C003", status: status(pair(), { state: "NOT_RUN", failureKind: "ENVIRONMENT", error: "disk full" }) },
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines.length).toBe(4);
    expect(lines[2]).toContain("FAILED");
    expect(lines[3]).toContain("NOT_RUN");
  });

  it("builds four files with one prefix", () => {
    const r = result([1, 2]);
    const out = batchFiles("my study", [{ caseLabel: "C001", result: r }],
      [{ caseLabel: "C001", status: status(pair()) }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.files.features.name).toBe("my_study.csv");
    expect(out.files.definitions.name).toBe("my_study_definitions.csv");
    expect(out.files.settings.name).toBe("my_study_radiomicsj.properties");
    expect(out.files.pairs.name).toBe("my_study_pairs.csv");
    expect(out.files.settings.text).toBe(r.settingsProperties);
  });

  it("falls back to a default prefix", () => {
    expect(batchFileBase("  ")).toBe("roi-features-batch");
  });
});

describe("applyLabelFilter", () => {
  const rows = () => initialRows([
    pair({ segmentLabel: "GTV" }), pair({ studyUid: "b", segmentLabel: "Tumor " }), pair({ studyUid: "c", segmentLabel: "liver" }),
    pair({ studyUid: "d", segmentLabel: null }), needs({ segmentLabel: "GTV" }), excluded({ segmentLabel: "GTV" }),
  ]);

  it("empty filter changes nothing", () => {
    expect(applyLabelFilter(rows(), [])).toEqual(rows());
  });

  it("keeps matching pairs (case- and space-insensitive) and turns the others off without removing them", () => {
    const out = applyLabelFilter(rows(), [" gtv", "TUMOR"]);
    expect(out.length).toBe(6);
    expect(out.map((r) => r.included)).toEqual([true, true, false, false, false, false]);
    expect(out.map((r) => r.filteredOut)).toEqual([false, false, true, true, false, false]);
  });

  it("a pair without a label never matches an active filter", () => {
    expect(applyLabelFilter(rows(), ["GTV"])[3].included).toBe(false);
  });

  it("removing the filter restores the pairs it turned off, but never touches a pair the filter did not turn off", () => {
    let r = rows();
    r = setIncluded(r, 0, false); // 利用者が手で外した（GTV＝絞り込みに合う組）
    r = applyLabelFilter(r, ["GTV"]);
    expect(r[0].included).toBe(false); // 絞り込みに合うので触らない
    expect(r[2].included).toBe(false); // liver は絞り込みが外した
    r = applyLabelFilter(r, []);
    expect(r[0].included).toBe(false); // 手で外した組は、絞り込みを外しても戻らない
    expect(r[2].included).toBe(true); // 絞り込みが外した組は戻る
    expect(r.map((x) => x.filteredOut)).toEqual([false, false, false, false, false, false]);
    expect(r[4].included).toBe(false); // 要確認は元画像を選ぶまで入らない
    expect(r[5].included).toBe(false); // 除外は戻らない
  });

  it("a manually included filtered-out pair stays included while the filter is unchanged", () => {
    let r = applyLabelFilter(rows(), ["GTV"]);
    r = setIncluded(r, 2, true);
    expect(r[2].included).toBe(true);
    expect(r[2].filteredOut).toBe(true);
  });
});

describe("QC in the request and the pair map", () => {
  it("carries qc and the acknowledged keys; defaults to none", () => {
    const form = defaultRoiFeatureForm();
    const a = buildBatchRequest([pair()], form);
    expect(a.qc).toBeNull();
    expect(a.qcAcknowledged).toBeNull();
    const b = buildBatchRequest([pair()], form, {
      qc: { smallRoi: "STOP", lossy: "FLAG" }, acknowledged: ["1.2.3|SEG|0"],
    });
    expect(b.qc).toEqual({ smallRoi: "STOP", lossy: "FLAG" });
    expect(b.qcAcknowledged).toEqual(["1.2.3|SEG|0"]);
  });

  it("writes QcFlags and the spec hash on every row of the pair map", () => {
    const st = (over: Partial<BatchPairStatusRow>): BatchPairStatusRow => ({
      index: 0, pair: pair(), state: "DONE", failureKind: null, error: null, fromCache: false, elapsedMs: 1, qcFlags: [], ...over,
    });
    const csv = pairsCsv([
      { caseLabel: "C001", status: st({}) },
      { caseLabel: "C002", status: st({ qcFlags: ["SMALL_ROI", "LOSSY_COMPRESSION"] }) },
    ], "ab".repeat(32));
    const lines = csv.trim().split("\r\n");
    expect(lines[0].endsWith("QcFlags,SpecSha256")).toBe(true);
    expect(lines[1].endsWith(`,,${"ab".repeat(32)}`)).toBe(true);
    expect(lines[2]).toContain("SMALL_ROI;LOSSY_COMPRESSION");
  });

  it("adds a spec file only when a spec is given", () => {
    const r = result([1, 2]);
    const items = [{ caseLabel: "C001", result: r }];
    const all = [{ caseLabel: "C001", status: { index: 0, pair: pair(), state: "DONE" as const, failureKind: null, error: null, fromCache: false, elapsedMs: 1, qcFlags: [] } }];
    const none = batchFiles("x", items, all);
    const withSpec = batchFiles("x", items, all, { sha256: "ff", text: "{}" });
    expect(none.ok && none.files.spec).toBeNull();
    expect(withSpec.ok && withSpec.files.spec?.name).toBe("x_spec.json");
  });
});

describe("smallRoiThresholdUnset", () => {
  const withThreshold = (n: number | null): RoiFeatureResult => {
    const r = result([1, 2]);
    return { ...r, roiSize: { ...r.roiSize, smallRoiWarnVoxels: n, smallRoi: n == null ? null : false } };
  };
  it("is true only when no result carries a threshold (not judged, which is not the same as no warning)", () => {
    expect(smallRoiThresholdUnset([withThreshold(null), withThreshold(null)])).toBe(true);
    expect(smallRoiThresholdUnset([withThreshold(null), withThreshold(1000)])).toBe(false);
    expect(smallRoiThresholdUnset([withThreshold(1000)])).toBe(false);
  });
  it("is false when there are no results yet", () => {
    expect(smallRoiThresholdUnset([])).toBe(false);
  });
});
