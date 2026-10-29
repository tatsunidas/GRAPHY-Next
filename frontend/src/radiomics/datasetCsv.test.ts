/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRow } from "../api";
import type { BatchPair, BatchPairStatusRow } from "./batchApi";
import {
  ID_COLUMNS,
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
