/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRow } from "../api";
import type { BatchJobState, BatchPair, BatchPairState, BatchStatus } from "./batchApi";
import {
  applyLabelFilter,
  assignCaseLabels,
  batchFileBase,
  buildBatchRequest,
  duplicateLabels,
  footerProgress,
  formatElapsed,
  includedSourceModalities,
  initialRows,
  modalitiesMixed,
  petWithDefaultBinWidth,
  selectedPairs,
  setIncluded,
  setSource,
  smallRoi2dThresholdUnset,
  smallRoiThresholdUnset,
  spacingMixText,
  summarize,
  voxelSpacingMix,
} from "./batchPairs";
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

describe("buildBatchRequest: PET の校正", () => {
  it("校正の指定（既定は auto）を要求に載せる。VOI 統計でも載る", () => {
    expect(buildBatchRequest([pair()], defaultRoiFeatureForm()).calibration).toBe("auto");
    const sul = { ...defaultRoiFeatureForm(), calibration: "sul-james" as const };
    expect(buildBatchRequest([pair()], sul).calibration).toBe("sul-james");
    expect(buildBatchRequest([pair()], sul, { kind: "voiStats" }).calibration).toBe("sul-james");
    expect(buildBatchRequest([pair()], { ...defaultRoiFeatureForm(), calibration: "none" as const }).calibration).toBe("none");
  });

  it("校正は RadiomicsJ の設定には入らない（backend が読み込みで使う）", () => {
    const req = buildBatchRequest([pair()], { ...defaultRoiFeatureForm(), calibration: "bw" as const });
    expect(Object.keys(req.settings).filter((k) => /calib|suv/i.test(k))).toEqual([]);
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
    expect(req.kind).toBeNull();
  });

  it("voiStats turns on the first-order family only, on the original grid, without a range", () => {
    const form = { ...defaultRoiFeatureForm(), resampleMm: 2, rangeMinText: "-500", rangeMaxText: "100", logOn: true };
    const req = buildBatchRequest([pair()], form, { kind: "voiStats" });
    expect(req.kind).toBe("voiStats");
    const on = Object.entries(req.settings).filter(([k, v]) => k.startsWith("BOOL_enable") && v === "1").map(([k]) => k);
    expect(on).toEqual(["BOOL_enableIntensityBasedStatistics"]);
    expect(Object.keys(req.settings).filter((k) => /^DOUBLE_range|resamplingFactor|logSigma|logTruncate|logPadding/.test(k))).toEqual([]);
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

describe("QC in the request", () => {
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
  it("carries the small-ROI threshold on its own, also for a trial (qc null)", () => {
    const form = defaultRoiFeatureForm();
    expect(buildBatchRequest([pair()], form).smallRoiWarnVoxels).toBeNull();
    expect(buildBatchRequest([pair()], form, { smallRoiVoxels: null }).smallRoiWarnVoxels).toBeNull();
    const trial = buildBatchRequest([pair()], form, { qc: null, smallRoiVoxels: 1000 });
    expect(trial.qc).toBeNull();
    expect(trial.smallRoiWarnVoxels).toBe(1000);
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

describe("batchFileBase", () => {
  it("replaces characters that cannot be in a file name, and falls back to a default", () => {
    expect(batchFileBase(" my study/1 ")).toBe("my_study_1");
    expect(batchFileBase("  ")).toBe("roi-features-batch");
  });
});

describe("buildBatchRequest: 2D の単位と断面", () => {
  const f = defaultRoiFeatureForm();
  const p: BatchPair[] = [];
  it("既定（3D だけ）は従来どおり。2D の単位を選ぶと roiModes に足され、断面は ALL のときだけ送る", () => {
    expect(buildBatchRequest(p, f).roiModes).toEqual(["WHOLE_3D"]);
    expect(buildBatchRequest(p, f).planes).toBeNull();
    const r = buildBatchRequest(p, { ...f, units2d: ["MAX_SECTION_2D", "SLICES_2D"] });
    expect(r.roiModes).toEqual(["WHOLE_3D", "MAX_SECTION_2D", "SLICES_2D"]);
    expect(r.planes).toBeNull();
    expect(buildBatchRequest(p, { ...f, units2d: ["SLICES_2D"], planesAll: true }).planes).toBe("ALL");
    // 2D の単位が無ければ断面は効かない
    expect(buildBatchRequest(p, { ...f, planesAll: true }).planes).toBeNull();
  });
  it("VOI 統計は 3D だけ（2D の単位・断面は送らない）", () => {
    const r = buildBatchRequest(p, { ...f, units2d: ["SLICES_2D"], planesAll: true }, { kind: "voiStats" });
    expect(r.roiModes).toEqual(["WHOLE_3D"]);
    expect(r.planes).toBeNull();
  });
});

describe("2D の小さい ROI の基準値", () => {
  const f = defaultRoiFeatureForm();
  it("2D の単位があるときだけ要求に入れる（3D だけ・VOI 統計では送らない）", () => {
    expect(buildBatchRequest([], f, { smallRoiPixels: 150 }).smallRoiWarnPixels).toBeNull();
    expect(buildBatchRequest([], { ...f, units2d: ["SLICES_2D"] }, { smallRoiPixels: 150 }).smallRoiWarnPixels).toBe(150);
    expect(buildBatchRequest([], { ...f, units2d: ["SLICES_2D"] }, {}).smallRoiWarnPixels).toBeNull();
    expect(buildBatchRequest([], { ...f, units2d: ["SLICES_2D"] }, { smallRoiPixels: 150, kind: "voiStats" }).smallRoiWarnPixels).toBeNull();
  });
  const res = (sec: number | null, sl: number | null, with2d = true) => ({
    ...(with2d ? { section: { roiSize: { smallRoiWarnVoxels: sec } }, slices: { smallRoiWarnPixels: sl } } : {}),
  }) as unknown as RoiFeatureResult;
  it("基準値が 2D のどの結果にも無いときだけ「未設定」。2D の結果が無ければ false", () => {
    expect(smallRoi2dThresholdUnset([res(null, null)])).toBe(true);
    expect(smallRoi2dThresholdUnset([res(150, null)])).toBe(false);
    expect(smallRoi2dThresholdUnset([res(null, 150)])).toBe(false);
    expect(smallRoi2dThresholdUnset([res(null, null, false)])).toBe(false);
    expect(smallRoi2dThresholdUnset([])).toBe(false);
  });
});

describe("元画像の画素間隔がそろっているか（voxelSpacingMix）", () => {
  const C = (a: "X" | "Y" | "Z") => `Diagnostics_DiagnosticsInitialImageVoxelDimension${a}`;
  const r = (x: number | null, y: number | null, z: number | null) => ({
    rows: [{ column: C("X"), value: x }, { column: C("Y"), value: y }, { column: C("Z"), value: z }],
  }) as unknown as RoiFeatureResult;

  it("そろっていれば mixed=false。z だけ違えば mixed=true で、軸ごとの範囲が出る", () => {
    expect(voxelSpacingMix([r(0.7, 0.7, 2), r(0.7, 0.7, 2)]).mixed).toBe(false);
    const m = voxelSpacingMix([r(0.7, 0.7, 1), r(0.7, 0.7, 3), r(0.7, 0.7, 3)]);
    expect(m.mixed).toBe(true);
    expect(m.perAxis).toEqual([{ min: 0.7, max: 0.7 }, { min: 0.7, max: 0.7 }, { min: 1, max: 3 }]);
    expect(m.usable).toBe(3);
    expect(spacingMixText(m)).toBe("x 0.7 mm、y 0.7 mm、z 1〜3 mm");
  });
  it("x・y だけ違うときも検出する。1 % 未満（丸め）は差にしない。1 % を超えれば差", () => {
    expect(voxelSpacingMix([r(0.7, 0.7, 2), r(0.9, 0.7, 2)]).mixed).toBe(true);
    expect(voxelSpacingMix([r(0.977, 0.977, 2), r(0.9766, 0.9766, 2)]).mixed).toBe(false);
    expect(voxelSpacingMix([r(1, 1, 2), r(1.005, 1, 2)]).mixed).toBe(false);
    expect(voxelSpacingMix([r(1, 1, 2), r(1.02, 1, 2)]).mixed).toBe(true);
  });
  it("取れない組（無い・0・NaN）は判定から外して未取得に数える。使える結果が 2 未満なら判定しない", () => {
    const m = voxelSpacingMix([r(0.7, 0.7, 1), r(0.7, 0.7, 3), r(null, 0.7, 3), r(0.7, 0.7, 0), { rows: [] } as unknown as RoiFeatureResult]);
    expect(m.usable).toBe(2);
    expect(m.unknown).toBe(3);
    expect(m.mixed).toBe(true);
    expect(voxelSpacingMix([r(0.7, 0.7, 1)]).mixed).toBe(false);
    expect(voxelSpacingMix([r(0.7, 0.7, 1), r(null, null, null)]).mixed).toBe(false);
    const none = voxelSpacingMix([]);
    expect(none).toEqual({ mixed: false, perAxis: [null, null, null], usable: 0, unknown: 0 });
    expect(spacingMixText(none)).toBe("x —、y —、z —");
  });
});

describe("formatElapsed", () => {
  it("分:秒、1 時間以上は 時:分:秒。負・NaN は 0:00", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(59_000)).toBe("0:59");
    expect(formatElapsed(61_000)).toBe("1:01");
    expect(formatElapsed(252_000)).toBe("4:12");
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(8_045_000)).toBe("2:14:05");
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("footerProgress", () => {
  const job = (state: BatchJobState, states: BatchPairState[]): BatchStatus => ({
    jobId: "j", state, elapsedMs: 252_000, total: states.length, done: states.filter((s) => s === "DONE").length, failed: 0,
    skipped: 0, notRun: 0, cancelled: 0, qcSkipped: 0, stopReason: null, stopKind: null, stopIndex: null,
    pairs: states.map((s, index) => ({ index, state: s, pair: {} as BatchPair, failureKind: null, error: null, fromCache: false, elapsedMs: 0, qcFlags: [] })),
  });
  const labels = ["C001", "C002", "C003"];
  it("実行中は今計算している組の番号とラベルを返す", () => {
    const f = footerProgress(job("RUNNING", ["DONE", "DONE", "RUNNING"]), labels);
    expect(f).toMatchObject({ running: true, index: 2, label: "C003", done: 2, failed: 0, total: 3, elapsedMs: 252_000 });
  });
  it("実行中でも計算中の組が無ければ index・ラベルは null（待機の合間）", () => {
    const f = footerProgress(job("QUEUED", ["PENDING", "PENDING", "PENDING"]), labels);
    expect(f).toMatchObject({ running: true, index: null, label: null });
  });
  it("ラベルが足りないときは label が null", () => {
    expect(footerProgress(job("RUNNING", ["RUNNING"]), []).label).toBeNull();
  });
  it("停止・取り消し・完了は running でなく、組の RUNNING 行があっても index を出さない", () => {
    for (const st of ["STOPPED", "CANCELLED", "DONE"] as const) {
      const f = footerProgress(job(st, ["DONE", "RUNNING", "PENDING"]), labels);
      expect(f.running).toBe(false);
      expect(f.index).toBeNull();
      expect(f.label).toBeNull();
    }
  });
});

describe("対象の組の元画像のモダリティ", () => {
  const mods: Record<string, string> = { CTS: "CT", PTS: "PT", CT2: "ct ", MRS: "MR" };
  const lookup = (_study: string, series: string) => mods[series];
  const rowOf = (source: string | null, included = true) =>
    ({ ...initialRows([pair({ sourceSeriesUid: source, sourceCandidates: source ? [source] : [] })])[0], source, included });

  it("CT と PT が混ざると 2 種類（混在あり）", () => {
    const m = includedSourceModalities([rowOf("CTS"), rowOf("PTS")], lookup);
    expect(m).toEqual(["CT", "PT"]);
    expect(modalitiesMixed(m)).toBe(true);
  });
  it("1 種類だけなら混在なし（大文字小文字・空白は無視して同じ扱い）", () => {
    const m = includedSourceModalities([rowOf("CTS"), rowOf("CT2")], lookup);
    expect(m).toEqual(["CT"]);
    expect(modalitiesMixed(m)).toBe(false);
  });
  it("対象から外した組・元画像が未確定の組・モダリティが分からない組は数えない", () => {
    const rows = [rowOf("CTS"), rowOf("PTS", false), rowOf(null), rowOf("UNKNOWN")];
    expect(includedSourceModalities(rows, lookup)).toEqual(["CT"]);
    expect(includedSourceModalities([], lookup)).toEqual([]);
  });
});

describe("PET の固定ビン幅が初期値のまま", () => {
  const base = defaultRoiFeatureForm();
  const binWidthMode = { ...base, fixedBinNumber: false };
  it("PET を含み、固定ビン幅が初期値の 25 のままなら true", () => {
    expect(petWithDefaultBinWidth(binWidthMode, ["PT"], "radiomics")).toBe(true);
    expect(petWithDefaultBinWidth(binWidthMode, ["CT", "PT"], "radiomics")).toBe(true);
  });
  it("PET が無い・ビン幅を変えた・固定ビン数・VOI 統計なら false", () => {
    expect(petWithDefaultBinWidth(binWidthMode, ["CT"], "radiomics")).toBe(false);
    expect(petWithDefaultBinWidth({ ...binWidthMode, binWidth: 0.1 }, ["PT"], "radiomics")).toBe(false);
    expect(petWithDefaultBinWidth(base, ["PT"], "radiomics")).toBe(false);
    expect(petWithDefaultBinWidth(binWidthMode, ["PT"], "voiStats")).toBe(false);
  });
});
