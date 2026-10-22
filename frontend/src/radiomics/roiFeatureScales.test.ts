/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRoiSize, RoiFeatureRow } from "../api";
import { ROI_FEATURE_RECORD_COLUMNS, ROI_FEATURE_SIZE_COLUMNS } from "./roiFeatureCsv";
import {
  defaultRoiFeatureForm, parseScaleList, roiFeatureScaleRequest, roiFeatureSettings,
} from "./roiFeatureSettings";
import {
  FILTER_COLUMNS, roiFeatureScaledDataCsv, roiFeatureScaledDefinitionsCsv, scale2dFiles, scaleSettingsFiles,
} from "./roiFeatureScales";

const row = (column: string, value: number | null): RoiFeatureRow => {
  const us = column.indexOf("_");
  return { column, family: column.slice(0, us), feature: column.slice(us + 1), ibsi: null, value, notes: [] };
};
const SIZE: RoiFeatureRoiSize = {
  initialVoxels: 1000, intensityVoxels: 982, morphVoxels: 1000, volumeMm3: 500, smallRoiWarnVoxels: null, smallRoi: null,
};
const res = (rows: RoiFeatureRow[], props: string, sha: string): RoiFeatureResult => ({
  radiomicsjVersion: "2.5.2", computedAt: "2026-10-22T05:03:00Z", fromCache: false, label: 1, rows,
  discretisation: { fixedBinNumber: true, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 },
  provenance: { graphyNextVersion: "0.6.0", radiomicsjVersion: "2.5.2", extractedAt: "2026-10-22T05:03:00Z", settingsSha256: sha },
  settingsProperties: props, roiSize: SIZE, lossyCompressed: false,
});

const base = [row("Morphology_Volume", 10), row("IntensityBasedStatistical_Mean", 5)];
const r0 = res(base, "A=0\n", "aa".repeat(32));
const r3 = res(
  [...base, row("log_sigma1.7321mm_IntensityBasedStatistical_Mean", -2.5)],
  "DOUBLE_logTruncate=4.0\nDOUBLEARRAY_logSigmaMm=1.7321\nSTRING_logPadding=MIRROR\n", "bb".repeat(32),
);
const full: RoiFeatureResult = {
  ...r0,
  scales: [
    { scaleMm: 0, sigma3dMm: null, sigma2dMm: null, conversion: "SQRT_D", coefficient: null, result: r0 },
    { scaleMm: 3, sigma3dMm: 1.7321, sigma2dMm: 2.1213, conversion: "SQRT_D", coefficient: null, result: r3 },
  ],
};
const splitRow = (l: string) => l.split(",");

describe("parseScaleList", () => {
  it("accepts commas and spaces, drops duplicates, keeps 0", () => {
    expect(parseScaleList("0, 2  3,3 4.5")).toEqual([0, 2, 3, 4.5]);
  });
  it("refuses empty, negative and non-numeric input", () => {
    expect(parseScaleList("")).toBeNull();
    expect(parseScaleList("0, -1")).toBeNull();
    expect(parseScaleList("2, x")).toBeNull();
    expect(parseScaleList("Infinity")).toBeNull();
  });
});

describe("scale request", () => {
  it("is empty unless LoG by radius is chosen, and never sends a sigma then", () => {
    const f = defaultRoiFeatureForm();
    expect(roiFeatureScaleRequest(f)).toEqual({});
    expect(roiFeatureScaleRequest({ ...f, logOn: true })).toEqual({});
    const byR = { ...f, logOn: true, logByRadius: true };
    expect(roiFeatureScaleRequest(byR)).toEqual({ scalesMm: [0, 2, 3, 4, 5, 6], scaleConversion: "SQRT_D" });
    expect(roiFeatureSettings(byR).DOUBLEARRAY_logSigmaMm).toBeUndefined();
    expect(roiFeatureSettings(byR).DOUBLE_logTruncate).toBe("4");
    expect(roiFeatureScaleRequest({ ...byR, scaleConversion: "COEFFICIENT", scaleK: 1.5 }))
      .toEqual({ scalesMm: [0, 2, 3, 4, 5, 6], scaleConversion: "COEFFICIENT", scaleCoefficient: 1.5 });
    // σ で指定するときは従来どおり
    expect(roiFeatureSettings({ ...f, logOn: true }).DOUBLEARRAY_logSigmaMm).toBe("1.5");
  });
});

describe("scaled CSV", () => {
  const lines = roiFeatureScaledDataCsv(full, "case1").trimEnd().split("\r\n");
  const head = splitRow(lines[0]);

  it("has one row per scale and the Filter columns after the size columns", () => {
    expect(lines).toHaveLength(3);
    const n = ROI_FEATURE_RECORD_COLUMNS.length + ROI_FEATURE_SIZE_COLUMNS.length;
    expect(head.slice(n, n + FILTER_COLUMNS.length)).toEqual([...FILTER_COLUMNS]);
    expect(head.slice(n + FILTER_COLUMNS.length)).toEqual([
      "Morphology_Volume", "IntensityBasedStatistical_Mean", "log_sigma1.7321mm_IntensityBasedStatistical_Mean",
    ]);
  });

  it("writes the filter record for LoG rows and leaves it empty for r=0 (never 0)", () => {
    const col = (name: string, line: string) => splitRow(line)[head.indexOf(name)];
    expect(col("Filter_Kind", lines[1])).toBe("none");
    expect(col("Filter_ScaleMm", lines[1])).toBe("0");
    for (const c of FILTER_COLUMNS.slice(2)) expect(col(c, lines[1])).toBe("");
    expect(col("Filter_Kind", lines[2])).toBe("LoG");
    expect(col("Filter_ScaleMm", lines[2])).toBe("3");
    expect(col("Filter_SigmaMm", lines[2])).toBe("1.7321");
    expect(col("Filter_ScaleToSigma", lines[2])).toBe("SQRT_D");
    expect(col("Filter_Dimension", lines[2])).toBe("3D");
    expect(col("Filter_TruncateSigma", lines[2])).toBe("4.0");
    expect(col("Filter_Boundary", lines[2])).toBe("MIRROR");
  });

  it("leaves columns a scale does not have empty, and keeps each row's own settings hash", () => {
    const col = (name: string, line: string) => splitRow(line)[head.indexOf(name)];
    const logCol = "log_sigma1.7321mm_IntensityBasedStatistical_Mean";
    expect(col(logCol, lines[1])).toBe("");
    expect(col(logCol, lines[2])).toBe("-2.5");
    expect(col("Provenance_SettingsSha256", lines[1])).toBe("aa".repeat(32));
    expect(col("Provenance_SettingsSha256", lines[2])).toBe("bb".repeat(32));
    expect(col("CaseLabel", lines[2])).toBe("case1");
  });

  it("definitions list the union of columns and the Filter columns", () => {
    const d = roiFeatureScaledDefinitionsCsv(full);
    expect(d).toContain("Filter_Kind,Filter,Kind");
    expect(d).toContain("log_sigma1.7321mm_IntensityBasedStatistical_Mean");
    expect(d).toContain("Morphology_Volume");
  });
});

describe("scale files", () => {
  it("writes one settings file per scale, byte for byte", () => {
    const f = scaleSettingsFiles(full);
    expect(f.map((x) => x.suffix)).toEqual(["-r0_radiomicsj.properties", "-r3_radiomicsj.properties"]);
    expect(f[1].text).toBe(r3.settingsProperties);
  });
  it("has no 2D files when no 2D unit was chosen", () => {
    expect(scale2dFiles(full)).toEqual([]);
  });
});
