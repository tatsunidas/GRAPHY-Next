/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRow } from "../api";
import type { BatchPair, BatchPairStatusRow } from "./batchApi";
import {
  ID_COLUMNS,
  VOI_STATS_COLUMNS,
  VOLUME_ML_COLUMN,
  UTF8_BOM,
  assignSubjectCodes,
  datasetDefinitionsCsv,
  datasetFiles,
  datasetTable,
  subjectsCsv,
  type DatasetOptions,
  type DatasetRow,
  type DatasetTable,
  type SubjectInfo,
} from "./datasetCsv";
import { ROI_FEATURE_RECORD_COLUMNS, ROI_FEATURE_SIZE_COLUMNS, roiFeatureDataCsv } from "./roiFeatureCsv";

const pair = (over: Partial<BatchPair> = {}): BatchPair => ({
  studyUid: "1.2.3", sourceSeriesUid: "SRC", maskSeriesUid: "SEG", segmentNumber: 1, segmentLabel: "GTV",
  maskChannel: 0, status: "AUTO", reason: null, sourceCandidates: ["SRC"], ...over,
});
const row = (column: string, value: number | null): RoiFeatureRow => {
  const us = column.indexOf("_");
  return { column, family: column.slice(0, us), feature: column.slice(us + 1), ibsi: "X", value, notes: [] };
};
const result = (values: number[], columns = ["Stat_mean", "Stat_max"]): RoiFeatureResult => ({
  radiomicsjVersion: "2.7.0", computedAt: "2026-10-28T00:00:00Z", fromCache: false, label: 1,
  rows: columns.map((c, i) => row(c, values[i] ?? null)),
  discretisation: { fixedBinNumber: true, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 },
  provenance: { graphyNextVersion: "0.5.1", radiomicsjVersion: "2.7.0", extractedAt: "2026-10-28T00:00:00.1Z", settingsSha256: "ab".repeat(32) },
  settingsProperties: "INT_binCount=32\n",
  roiSize: { initialVoxels: 100, intensityVoxels: 100, morphVoxels: 100, volumeMm3: 50, smallRoiWarnVoxels: null, smallRoi: null },
  lossyCompressed: false,
});
const st = (p: BatchPair, over: Partial<BatchPairStatusRow> = {}): BatchPairStatusRow => ({
  index: 0, pair: p, state: "DONE", failureKind: null, error: null, fromCache: false, elapsedMs: 1, qcFlags: [], ...over,
});
const drow = (label: string, p: BatchPair, r: RoiFeatureResult | null, over: Partial<BatchPairStatusRow> = {}): DatasetRow => ({
  caseLabel: label, status: st(p, r ? over : { state: "FAILED", failureKind: "INPUT", error: "ROI が空です", ...over }), result: r,
});
const subjects = (m: Record<string, SubjectInfo>) => new Map(Object.entries(m));
const OPTS: DatasetOptions = { albumName: "lung", specSha256: "cd".repeat(32), includePatientId: false };

/** 1 行を CSV として分ける（試験用）。 */
function split(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}
const lines = (csv: string) => csv.split("\r\n").filter(Boolean);
const table = (r: ReturnType<typeof datasetTable>): DatasetTable => {
  expect(r.ok).toBe(true);
  return r as DatasetTable;
};

describe("assignSubjectCodes", () => {
  const pidOf = (m: Record<string, string>) => (u: string) => m[u];

  it("gives the same patient the same code, in the order of the album", () => {
    const codes = assignSubjectCodes(["a", "b", "c", "d"], pidOf({ a: "P1", b: "P2", c: "P1", d: "P3" }));
    expect([...codes.values()].map((s) => s.code)).toEqual(["S001", "S002", "S001", "S003"]);
    expect(codes.get("c")!.patientId).toBe("P1");
  });

  it("a study without a patient ID is its own subject (it cannot be matched)", () => {
    const codes = assignSubjectCodes(["a", "b", "c"], pidOf({ a: "", b: "  " }));
    expect([...codes.values()].map((s) => s.code)).toEqual(["S001", "S002", "S003"]);
    expect(codes.get("a")!.patientId).toBe("");
  });

  it("depends on the album order only — not on which pairs were selected", () => {
    const all = assignSubjectCodes(["a", "b", "c"], pidOf({ a: "P1", b: "P2", c: "P3" }));
    // 選んだ検査が c だけでも、コードは変わらない（割り当てにはアルバムの並びだけを使う）
    expect(all.get("c")!.code).toBe("S003");
  });

  it("adds a study that is in the table but not in the album list after the album's studies", () => {
    const codes = assignSubjectCodes(["a"], pidOf({ a: "P1", z: "P9" }), ["z"]);
    expect(codes.get("z")!.code).toBe("S002");
  });

  it("widens the number only when there are 1000 subjects or more", () => {
    const uids = Array.from({ length: 1000 }, (_, i) => `u${i}`);
    const codes = assignSubjectCodes(uids, (u) => u);
    expect(codes.get("u0")!.code).toBe("S0001");
    expect(assignSubjectCodes(["a"], () => "p").get("a")!.code).toBe("S001");
  });
});

describe("datasetTable", () => {
  const subj = subjects({ "1.2.3": { code: "S001", patientId: "PID-1" }, "1.2.4": { code: "S002", patientId: "PID-2" } });

  it("has one row per submitted pair, in the documented column order", () => {
    const rows = [
      drow("C001", pair(), result([1.5, 9])),
      drow("C002", pair({ studyUid: "1.2.4", segmentNumber: 2, segmentLabel: "Small", maskChannel: 1 }), result([2.5, 7])),
    ];
    const t = table(datasetTable(rows, subj, OPTS));
    const ls = lines(t.csv);
    expect(ls.length).toBe(3);
    expect(t.header).toEqual([
      "CaseLabel", ...ID_COLUMNS, ...ROI_FEATURE_RECORD_COLUMNS.slice(1), ...ROI_FEATURE_SIZE_COLUMNS, "Stat_mean", "Stat_max",
    ]);
    expect(split(ls[0])).toEqual(t.header);
    const r2 = Object.fromEntries(t.header.map((h, i) => [h, split(ls[2])[i]]));
    expect(r2).toMatchObject({
      CaseLabel: "C002", SubjectCode: "S002", Album: "lung", StudyInstanceUID: "1.2.4", SourceSeriesUID: "SRC",
      MaskSeriesUID: "SEG", Roi_SegmentNumber: "2", Roi_SegmentLabel: "Small", Roi_MaskChannel: "1",
      RowStatus: "DONE", RowFailureKind: "", RowError: "", Provenance_QcFlags: "", Provenance_SpecSha256: OPTS.specSha256,
      Stat_mean: "2.5", Stat_max: "7",
    });
  });

  it("the record, size and feature cells equal the existing single-case row (old path vs new path)", () => {
    const r = result([1.5, 9]);
    const t = table(datasetTable([drow("C001", pair(), r)], subj, OPTS));
    const old = lines(roiFeatureDataCsv(r, "C001")).map(split);
    const now = lines(t.csv).map(split);
    const pick = (header: string[], vals: string[], names: readonly string[]) => names.map((n) => vals[header.indexOf(n)]);
    const names = [...ROI_FEATURE_RECORD_COLUMNS, ...ROI_FEATURE_SIZE_COLUMNS, "Stat_mean", "Stat_max"];
    expect(pick(now[0], now[1], names)).toEqual(pick(old[0], old[1], names));
    expect(names.map((n) => now[0].indexOf(n)).every((i) => i >= 0)).toBe(true);
  });

  it("keeps failed, not-run and cancelled pairs as rows with blank features and their status", () => {
    const rows = [
      drow("C001", pair(), result([1, 2])),
      drow("C002", pair({ studyUid: "1.2.4" }), null),
      drow("C003", pair(), null, { state: "NOT_RUN", failureKind: "ENVIRONMENT", error: "disk full" }),
      drow("C004", pair(), null, { state: "CANCELLED", failureKind: null, error: null }),
    ];
    const t = table(datasetTable(rows, subj, OPTS));
    const ls = lines(t.csv);
    expect(ls.length).toBe(5); // 見出し + 送った組の数
    const get = (i: number) => Object.fromEntries(t.header.map((h, k) => [h, split(ls[i])[k]]));
    expect(get(2)).toMatchObject({ RowStatus: "FAILED", RowFailureKind: "INPUT", RowError: "ROI が空です", Stat_mean: "", Stat_max: "", Roi_InitialVoxels: "", Provenance_ExtractedAt: "" });
    expect(get(3)).toMatchObject({ RowStatus: "NOT_RUN", RowFailureKind: "ENVIRONMENT", RowError: "disk full", Stat_mean: "" });
    expect(get(4)).toMatchObject({ RowStatus: "CANCELLED", Stat_mean: "" });
    // 欠損を 0 や NaN の文字で埋めない
    expect(split(ls[2]).slice(-2)).toEqual(["", ""]);
    // 失敗の行にも、識別と定義の SHA-256 は残る
    expect(get(2)).toMatchObject({ CaseLabel: "C002", SubjectCode: "S002", StudyInstanceUID: "1.2.4", Provenance_SpecSha256: OPTS.specSha256 });
  });

  it("records the QC flags of a pair", () => {
    const t = table(datasetTable([drow("C001", pair(), result([1, 2]), { qcFlags: ["SMALL_ROI", "LOSSY_COMPRESSION"] })], subj, OPTS));
    expect(split(lines(t.csv)[1])[t.header.indexOf("Provenance_QcFlags")]).toBe("SMALL_ROI;LOSSY_COMPRESSION");
  });

  it("refuses to stack results whose columns differ, naming the case", () => {
    const out = datasetTable([
      drow("C001", pair(), result([1, 2])),
      drow("C002", pair(), result([1, 2], ["Stat_mean", "Other_x"])),
    ], subj, OPTS);
    expect(out).toEqual({ ok: false, reason: "header mismatch", caseLabel: "C002" });
  });

  it("refuses when nothing was computed, and when a DONE pair has no result", () => {
    expect(datasetTable([drow("C001", pair(), null)], subj, OPTS)).toMatchObject({ ok: false, reason: "no results" });
    const inconsistent: DatasetRow = { caseLabel: "C002", status: st(pair(), { state: "DONE" }), result: null };
    expect(datasetTable([drow("C001", pair(), result([1, 2])), inconsistent], subj, OPTS))
      .toEqual({ ok: false, reason: "missing result", caseLabel: "C002" });
  });

  it("adds PatientID only when asked", () => {
    const rows = [drow("C001", pair(), result([1, 2]))];
    const off = table(datasetTable(rows, subj, OPTS));
    expect(off.header).not.toContain("PatientID");
    expect(off.csv).not.toContain("PID-1");
    const on = table(datasetTable(rows, subj, { ...OPTS, includePatientId: true }));
    expect(on.header.slice(0, 3)).toEqual(["CaseLabel", "PatientID", "SubjectCode"]);
    expect(split(lines(on.csv)[1])[1]).toBe("PID-1");
  });

  it("the numeric identification columns are named so that the statistics plugin does not take them as features", () => {
    // 研究統計プラグインは、Roi_・Provenance_・Warning_ などで始まる列を特徴量の既定から除く
    const NON_FEATURE = /^(Provenance_|Roi_|Warning_|Filter_|Diagnostics_)/;
    const t = table(datasetTable([drow("C001", pair(), result([1, 2]))], subj, OPTS));
    const vals = split(lines(t.csv)[1]);
    for (const [i, h] of t.header.entries()) {
      const numeric = vals[i] !== "" && Number.isFinite(Number(vals[i]));
      if (numeric && !t.featureColumns.includes(h)) expect(NON_FEATURE.test(h), `${h} は数なので除外される名前にする`).toBe(true);
    }
  });

  it("escapes cells (commas, quotes, line breaks in labels and errors)", () => {
    const r = drow("C,001", pair({ segmentLabel: 'a"b' }), null, { error: "x\ny, z" });
    const t = table(datasetTable([drow("C000", pair(), result([1, 2])), r], subj, OPTS));
    const cells = split(t.csv.split("\r\n").slice(2).join("\r\n").replace(/\r\n$/, ""));
    expect(cells[0]).toBe("C,001");
    expect(cells[t.header.indexOf("Roi_SegmentLabel")]).toBe('a"b');
    expect(cells[t.header.indexOf("RowError")]).toBe("x\ny, z");
  });
});

describe("a patient ID reaches only the private subject file (and the PatientID column when asked)", () => {
  it("is in no other file and no other column", () => {
    // 患者名はこの関数群の入力に無い（型にも無い）。患者 ID だけが、対応表（と、選んだときの表の列）に入る。
    const subj = subjects({ "1.2.3": { code: "S001", patientId: "PID-SECRET-1" } });
    const out = datasetFiles([drow("C001", pair(), result([1, 2]))], subj, {
      ...OPTS, base: "x", specText: "{}", subjectsFile: true, bom: false, includePatientId: false,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.files.filter((f) => f.text.includes("PID-SECRET-1")).map((f) => f.name)).toEqual(["x_subjects_private.csv"]);
    const on = datasetFiles([drow("C001", pair(), result([1, 2]))], subj, {
      ...OPTS, base: "x", specText: "{}", subjectsFile: true, bom: false, includePatientId: true,
    });
    expect(on.ok && on.files.filter((f) => f.text.includes("PID-SECRET-1")).map((f) => f.name)).toEqual(["x.csv", "x_subjects_private.csv"]);
  });
});

describe("datasetDefinitionsCsv", () => {
  it("has exactly one line per column of the table, in the same order", () => {
    const subj = subjects({ "1.2.3": { code: "S001", patientId: "P" } });
    for (const includePatientId of [false, true]) {
      const t = table(datasetTable([drow("C001", pair(), result([1, 2]))], subj, { ...OPTS, includePatientId }));
      const defs = lines(datasetDefinitionsCsv(t)).slice(1).map((l) => split(l)[0]);
      expect(defs).toEqual(t.header);
    }
  });

  it("describes the identification columns", () => {
    const subj = subjects({ "1.2.3": { code: "S001", patientId: "P" } });
    const t = table(datasetTable([drow("C001", pair(), result([1, 2]))], subj, OPTS));
    const byCol = Object.fromEntries(lines(datasetDefinitionsCsv(t)).slice(1).map((l) => [split(l)[0], split(l)]));
    expect(byCol.SubjectCode.slice(1, 3)).toEqual(["Id", "SubjectCode"]);
    expect(byCol.Roi_SegmentNumber[1]).toBe("Roi");
    expect(byCol.RowStatus[1]).toBe("Row");
    expect(byCol.Provenance_SpecSha256[1]).toBe("Provenance");
  });
});

describe("subjectsCsv", () => {
  it("has SubjectCode, PatientID and StudyInstanceUID, one line per study in the table, in album order", () => {
    const subj = subjects({
      "1.2.3": { code: "S001", patientId: "P1" }, "1.2.4": { code: "S002", patientId: "" }, "1.2.5": { code: "S003", patientId: "P3" },
    });
    const csv = subjectsCsv(subj, new Set(["1.2.5", "1.2.3", "1.2.4"]));
    expect(lines(csv)).toEqual(["SubjectCode,PatientID,StudyInstanceUID", "S001,P1,1.2.3", "S002,,1.2.4", "S003,P3,1.2.5"]);
    expect(lines(subjectsCsv(subj, new Set(["1.2.5"])))).toEqual(["SubjectCode,PatientID,StudyInstanceUID", "S003,P3,1.2.5"]);
  });
});

describe("datasetFiles", () => {
  const subj = subjects({ "1.2.3": { code: "S001", patientId: "P1" } });
  const rows = [drow("C001", pair(), result([1, 2]))];
  const base = { ...OPTS, base: "lung-ct", specText: '{"a":1}\n', subjectsFile: true, bom: false };

  it("writes the table, definitions, settings, definition JSON and (when asked) the private subject file", () => {
    const out = datasetFiles(rows, subj, base);
    expect(out.ok && out.files.map((f) => f.name)).toEqual([
      "lung-ct.csv", "lung-ct_definitions.csv", "lung-ct_radiomicsj.properties", "lung-ct_spec.json", "lung-ct_subjects_private.csv",
    ]);
    const off = datasetFiles(rows, subj, { ...base, subjectsFile: false });
    expect(off.ok && off.files.map((f) => f.name)).toEqual(["lung-ct.csv", "lung-ct_definitions.csv", "lung-ct_radiomicsj.properties", "lung-ct_spec.json"]);
  });

  it("puts a BOM on the CSV files only, and only when asked", () => {
    const withBom = datasetFiles(rows, subj, { ...base, bom: true });
    expect(withBom.ok).toBe(true);
    if (!withBom.ok) return;
    for (const f of withBom.files) {
      const isCsv = f.name.endsWith(".csv");
      expect(f.text.startsWith(UTF8_BOM), f.name).toBe(isCsv);
      if (isCsv) expect(Array.from(new TextEncoder().encode(f.text).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    }
    const none = datasetFiles(rows, subj, base);
    expect(none.ok && none.files.some((f) => f.text.startsWith(UTF8_BOM))).toBe(false);
  });

  it("passes through the failure of the table", () => {
    expect(datasetFiles([], subj, base)).toMatchObject({ ok: false, reason: "no results" });
  });

  it("the settings file is the one of the first computed result, unchanged", () => {
    const out = datasetFiles(rows, subj, base);
    expect(out.ok && out.files.find((f) => f.name.endsWith(".properties"))!.text).toBe("INT_binCount=32\n");
  });
});

describe("voiStats table", () => {
  const cols = ["Diagnostics_Voxels", ...VOI_STATS_COLUMNS, "Morphology_Volume"];
  const r = (vol: number | null) => ({ ...result([7, 1, 2, 3, 4, 5, 9], cols), roiSize: { ...result([]).roiSize, volumeMm3: vol } });
  const vopts: DatasetOptions = { ...OPTS, kind: "voiStats" };

  it("keeps the 5 statistics and adds the volume in mL after the size columns", () => {
    const t = datasetTable([drow("A", pair(), r(5644.8))], subjects({}), vopts);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.featureColumns).toEqual([...VOI_STATS_COLUMNS]);
    const at = t.header.indexOf(VOLUME_ML_COLUMN);
    expect(at).toBe(t.header.indexOf(ROI_FEATURE_SIZE_COLUMNS[ROI_FEATURE_SIZE_COLUMNS.length - 1]) + 1);
    const cells = split(t.csv.split("\r\n")[1]);
    expect(cells[at]).toBe("5.6448");
    expect(cells.slice(at + 1)).toEqual(["1", "2", "3", "4", "5"]);
    expect(t.csv).not.toContain("Diagnostics_Voxels");
  });

  it("a failed row has blanks under every column and the same width", () => {
    const t = datasetTable([drow("A", pair(), r(1000)), drow("B", pair({ studyUid: "9" }), null)], subjects({}), vopts);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const lines = t.csv.split("\r\n");
    expect(split(lines[2]).length).toBe(t.header.length);
    expect(split(lines[2]).slice(t.header.indexOf(VOLUME_ML_COLUMN))).toEqual(Array(1 + VOI_STATS_COLUMNS.length).fill(""));
  });

  it("stops when a result lacks one of the statistics (never shifts columns)", () => {
    const bad = result([1, 2], ["IntensityBasedStatistical_Mean", "Morphology_Volume"]);
    const t = datasetTable([drow("A", pair(), bad)], subjects({}), vopts);
    expect(t.ok ? "ok" : t.reason).toBe("header mismatch");
  });

  it("the definitions table describes the volume column", () => {
    const t = datasetTable([drow("A", pair(), r(1000))], subjects({}), vopts);
    if (!t.ok) throw new Error("table");
    const defs = datasetDefinitionsCsv(t).split("\r\n");
    expect(defs.some((l) => l.startsWith(`${VOLUME_ML_COLUMN},Roi,VolumeMl`))).toBe(true);
  });

  it("without a kind the table is unchanged (all result columns, no mL column)", () => {
    const t = datasetTable([drow("A", pair(), r(1000))], subjects({}), OPTS);
    if (!t.ok) throw new Error("table");
    expect(t.featureColumns).toEqual(cols);
    expect(t.header).not.toContain(VOLUME_ML_COLUMN);
  });
});


describe("2D の単位を含む表（twoD）", () => {
  const rec = (plane: string) => ({ plane, tiltDeg: 0, provenance: { graphyNextVersion: "0.5.1", radiomicsjVersion: "2.7.0", extractedAt: "2026-10-28T00:00:00.2Z", settingsSha256: "ef".repeat(32) }, settingsProperties: "BOOL_force2D=1\n", discretisation: { fixedBinNumber: true, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 } });
  const sec = (plane: string, pos: number, px: number) => ({ fromCache: false, rows: [row("Stat_mean", px), row("Shape2D_PixelSurface", px * 2)], positionMm: pos, areaMm2: px * 0.5, pixels: px, record: rec(plane) });
  const sli = (plane: string, positions: number[]) => ({
    fromCache: false, failures: [], foregroundSlices: positions.length, record: rec(plane), mean: [], pixelWeightedMean: [], slicesUsed: {},
    rows: positions.map((p, i) => ({ positionMm: p, areaMm2: 1, pixels: 10 + i, rows: [row("Stat_mean", p)] })),
  });
  const full = (): RoiFeatureResult => ({
    ...result([1, 2]),
    section: sec("AXIAL", 10, 225), slices: sli("AXIAL", [8, 10]),
    planeResults: [
      { plane: "AXIAL", spacingMm: 0.7, section: sec("AXIAL", 10, 200), slices: sli("AXIAL", [9, 10, 11]) },
      { plane: "SAGITTAL", spacingMm: 0.7, section: null, slices: null, error: "スライスが 1 枚だけのため、別の断面を作れません。" },
    ],
  } as unknown as RoiFeatureResult);
  const OPTS2 = { ...OPTS, twoD: true };

  it("3D だけの表は、twoD を付けなければ従来と全く同じ（バイト一致）", () => {
    const rows = [drow("c1", pair(), result([1, 2])), drow("c2", pair({ studyUid: "9" }), result([3, 4]))];
    const a = table(datasetTable(rows, subjects({}), OPTS)).csv;
    const b = table(datasetTable(rows, subjects({}), { ...OPTS, twoD: false })).csv;
    expect(b).toBe(a);
    expect(lines(a)[0]).not.toContain("RowKey");
  });

  it("組ごとに 3D の 1 行と 2D の各行が縦に並び、列は 3D の列→2D にだけある列", () => {
    const t = table(datasetTable([drow("c1", pair(), full())], subjects({}), OPTS2));
    const L = lines(t.csv);
    const h = split(L[0]);
    // 取得面: 最大断面 1 + スライス 2、再スライス AXIAL: 最大断面 1 + スライス 3（SAGITTAL は作れず行なし）+ 3D の 1 行
    expect(L.length - 1).toBe(1 + 1 + 2 + 1 + 3);
    expect(t.featureColumns).toEqual(["Stat_mean", "Stat_max", "Shape2D_PixelSurface"]);
    const col = (r: string[], n: string) => r[h.indexOf(n)];
    const body = L.slice(1).map(split);
    expect(body.map((r) => col(r, "Unit"))).toEqual(["WHOLE_3D", "MAX_SECTION_2D", "SLICE_2D", "SLICE_2D", "MAX_SECTION_2D", "SLICE_2D", "SLICE_2D", "SLICE_2D"]);
    expect(body.map((r) => col(r, "PlaneSource"))).toEqual(["", "ACQUISITION", "ACQUISITION", "ACQUISITION", "RESLICED", "RESLICED", "RESLICED", "RESLICED"]);
    // 2D の行: 位置・面積・画素数が入り、3D の大きさの列は空。計算しない特徴は空欄（0・NaN を書かない）
    const sec1 = body[1];
    expect(col(sec1, "Roi_PositionMm")).toBe("10");
    expect(col(sec1, "Roi_Pixels")).toBe("225");
    expect(col(sec1, "Roi_VolumeMm3")).toBe("");
    expect(col(sec1, "Stat_max")).toBe("");
    expect(col(sec1, "Shape2D_PixelSurface")).toBe("450");
    expect(col(body[0], "Shape2D_PixelSurface")).toBe("");
    expect(col(body[0], "Stat_max")).toBe("2");
    // 2D の行の記録は 2D の設定の SHA-256
    expect(col(sec1, "Provenance_SettingsSha256")).toBe("ef".repeat(32));
    expect(col(body[0], "Provenance_SettingsSha256")).toBe("ab".repeat(32));
  });

  it("RowKey は全行で一意（取得面と再スライスの同名の断面でも）。数の識別の列は Roi_ で始まる", () => {
    const rows = [drow("c1", pair(), full()), drow("c2", pair({ studyUid: "9" }), full())];
    const L = lines(table(datasetTable(rows, subjects({}), OPTS2)).csv);
    const h = split(L[0]);
    const keys = L.slice(1).map((l) => split(l)[h.indexOf("RowKey")]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[1]).toBe("c1|MAX_SECTION_2D|ACQUISITION|AXIAL|10");
    expect(keys.some((k) => k.startsWith("c1|MAX_SECTION_2D|RESLICED|AXIAL|"))).toBe(true);
    for (const n of ["Roi_PlaneTiltDeg", "Roi_PositionMm", "Roi_AreaMm2", "Roi_Pixels"]) expect(h).toContain(n);
  });

  it("失敗した組は 1 行（単位は空、RowKey は CaseLabel）で、行は消えない", () => {
    const rows = [drow("c1", pair(), full()), drow("c2", pair({ studyUid: "9" }), null)];
    const L = lines(table(datasetTable(rows, subjects({}), OPTS2)).csv);
    const h = split(L[0]);
    const last = split(L[L.length - 1]);
    expect(last[h.indexOf("RowStatus")]).toBe("FAILED");
    expect(last[h.indexOf("Unit")]).toBe("");
    expect(last[h.indexOf("RowKey")]).toBe("c2");
    expect(last.length).toBe(h.length);
    expect(L.every((l) => split(l).length === h.length)).toBe(true);
  });

  it("定義表に、特徴量の列を計算した単位が付く", () => {
    const t = table(datasetTable([drow("c1", pair(), full())], subjects({}), OPTS2));
    const d = lines(datasetDefinitionsCsv(t)).map(split);
    expect(d[0][d[0].length - 1]).toBe("units");
    const u = (c: string) => d.find((r) => r[0] === c)![d[0].length - 1];
    expect(u("Stat_mean")).toBe("WHOLE_3D;MAX_SECTION_2D;SLICE_2D");
    expect(u("Stat_max")).toBe("WHOLE_3D");
    expect(u("Shape2D_PixelSurface")).toBe("MAX_SECTION_2D");
    expect(d.find((r) => r[0] === "RowKey")![4]).toContain("feature-id");
    expect(d.every((r) => r.length === d[0].length)).toBe(true);
  });

  it("3D の行の見出しが組の間で違えば止める（従来どおり）。2D の設定ファイルを書く", () => {
    const bad = datasetTable([drow("c1", pair(), full()), drow("c2", pair({ studyUid: "9" }), result([1], ["Other_x"]))], subjects({}), OPTS2);
    expect(bad).toEqual({ ok: false, reason: "header mismatch", caseLabel: "c2" });
    const r = datasetFiles([drow("c1", pair(), full())], subjects({}), { ...OPTS2, base: "b", specText: "{}", subjectsFile: false, bom: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files.find((f) => f.name === "b_radiomicsj_2d.properties")?.text).toBe("BOOL_force2D=1\n");
  });
});
