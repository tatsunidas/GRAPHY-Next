/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRoiSize, RoiFeatureRow } from "../api";
import { SIX_STATISTICS } from "./roiSummaryStats";
import {
  DEFAULT_GROUPS, WideCsvError, duplicateScale, groupOf, parseGroupText, prefixOf, roiFeatureWideCsv,
  roiFeatureWideDefinitionsCsv, scalePrefix, scaleTable,
} from "./roiScaleTable";

const SIX = SIX_STATISTICS.map((d) => d.column);
const EXTRA = "IntensityBasedStatistical_Variance";

const row = (column: string, value: number | null): RoiFeatureRow => {
  const m = /^(log_sigma[^_]+)_(.+)$/.exec(column);
  const base = m ? m[2] : column;
  const us = base.indexOf("_");
  const family = (m ? `${m[1]}_` : "") + base.slice(0, us);
  return { column, family, feature: base.slice(us + 1), ibsi: m ? null : "ABCD", value, notes: m ? ["LOG_FILTERED"] : [] };
};
const SIZE: RoiFeatureRoiSize = {
  initialVoxels: 1000, intensityVoxels: 982, morphVoxels: 1000, volumeMm3: 500, smallRoiWarnVoxels: null, smallRoi: null,
};
const result = (rows: RoiFeatureRow[], tag: number, size = SIZE): RoiFeatureResult => ({
  radiomicsjVersion: "2.7.0", computedAt: "2026-10-26T05:03:00Z", fromCache: false, label: 1, rows,
  discretisation: { fixedBinNumber: true, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 },
  provenance: { graphyNextVersion: "0.6.0", radiomicsjVersion: "2.7.0", extractedAt: `2026-10-26T05:03:0${tag}Z`, settingsSha256: String.fromCharCode(97 + tag).repeat(64) },
  settingsProperties: "DOUBLE_logTruncate=4.0\nSTRING_logPadding=MIRROR\n", roiSize: size, lossyCompressed: false,
});
/** r の値ごとに値が違う（取り違えが分かる）: base 列の j 番目の値 = 100 * r + j。 */
const entry = (r: number, extra: string[] = [], size = SIZE) => {
  const sigma = r === 0 ? null : Math.round((r / Math.sqrt(3)) * 1e4) / 1e4;
  const prefix = r === 0 ? "" : `log_sigma${sigma}mm_`;
  const cols = [...SIX, ...extra];
  const rows = [
    row("Morphology_Volume", 10),
    ...cols.map((c, j) => row(`${prefix}${c}`, 100 * r + j)),
    // r>0 の結果には元の画像の列もある（表の行には使わない）
    ...(r === 0 ? [] : cols.map((c) => row(c, -1))),
  ];
  return {
    scaleMm: r, sigma3dMm: sigma, sigma2dMm: sigma == null ? null : sigma * 1.2, conversion: "SQRT_D", coefficient: null,
    inputNotation: "radius_mm" as const, inputValue: r, pixelSpacingMm: null, legacyLabel: null,
    result: result(rows, Math.floor(r) % 10, size),
  };
};
const fullOf = (rs: number[], extra: string[] = []): RoiFeatureResult => {
  const scales = rs.map((r) => entry(r, extra));
  return { ...scales[0].result, scales };
};
const lines = (csv: string) => csv.trimEnd().split("\r\n").map((l) => l.split(","));

describe("groups", () => {
  it("assigns the default groups and never guesses for other radii", () => {
    expect([0, 2, 3, 4, 5, 6].map((r) => groupOf(r, DEFAULT_GROUPS))).toEqual(["none", "fine", "medium", "medium", "medium", "coarse"]);
    expect(groupOf(2.5, DEFAULT_GROUPS)).toBe("ungrouped");
    expect(groupOf(7, DEFAULT_GROUPS)).toBe("ungrouped");
  });
  it("parses and checks the group text", () => {
    expect(parseGroupText("3, 4  5")).toEqual([3, 4, 5]);
    expect(parseGroupText("")).toEqual([]);
    expect(parseGroupText("3,x")).toBeNull();
    expect(parseGroupText("0")).toBeNull();
    expect(duplicateScale({ fine: [2], medium: [2, 3], coarse: [] })).toBe(2);
    expect(duplicateScale(DEFAULT_GROUPS)).toBeNull();
  });
});

describe("scale table", () => {
  const full = fullOf([0, 2, 3, 4, 5, 6]);
  it("puts the six statistics first, one column per scale, each value from that scale's own column", () => {
    const t = scaleTable(full, DEFAULT_GROUPS);
    expect(t.columns.map((c) => c.scaleMm)).toEqual([0, 2, 3, 4, 5, 6]);
    expect(t.columns.map((c) => c.group)).toEqual(["none", "fine", "medium", "medium", "medium", "coarse"]);
    expect(t.rows.map((r) => r.base)).toEqual(SIX);
    expect(t.rows.map((r) => r.label)).toEqual(SIX_STATISTICS.map((d) => d.label));
    t.rows.forEach((r, j) => expect(r.values).toEqual([0, 2, 3, 4, 5, 6].map((s) => 100 * s + j)));
  });
  it("uses the filtered column at r>0, not the original-image column of the same result", () => {
    const t = scaleTable(full, DEFAULT_GROUPS);
    expect(t.rows.every((r) => r.values.every((v) => v !== -1))).toBe(true);
  });
  it("keeps only rows that every scale has", () => {
    const f = fullOf([0, 3]);
    f.scales![0].result.rows.push(row(EXTRA, 1)); // r=0 だけが持つ列
    const t = scaleTable(f, DEFAULT_GROUPS);
    expect(t.rows.map((r) => r.base)).toEqual(SIX);
  });
  it("lists the other common features after the six", () => {
    const t = scaleTable(fullOf([0, 3], [EXTRA]), DEFAULT_GROUPS);
    expect(t.rows.map((r) => r.base)).toEqual([...SIX, EXTRA]);
  });
  it("shows an undefined value as null, never 0", () => {
    const f = fullOf([0, 3]);
    f.scales![1].result.rows.find((r) => r.column.endsWith("AuxiliaryStatistics_MeanOfPositiveIntensities"))!.value = null;
    const mpp = scaleTable(f, DEFAULT_GROUPS).rows.find((r) => r.label === "MPP")!;
    expect(mpp.values[1]).toBeNull();
    expect(roiFeatureWideCsv(f).split("\r\n")[1]).toContain("NaN");
  });
  it("changing the groups changes only the group, not a value", () => {
    const a = scaleTable(full, DEFAULT_GROUPS);
    const b = scaleTable(full, { fine: [2, 3], medium: [4], coarse: [5, 6] });
    expect(b.rows).toEqual(a.rows);
    expect(b.columns.map((c) => c.group)).not.toEqual(a.columns.map((c) => c.group));
  });
  it("finds the prefix from the rows", () => {
    expect(prefixOf(full.scales![0])).toBe("");
    expect(prefixOf(full.scales![2])).toBe("log_sigma1.7321mm_");
    const bad = entry(3);
    bad.result.rows = bad.result.rows.filter((r) => !r.column.startsWith("log_sigma"));
    expect(prefixOf(bad)).toBeNull();
    expect(scaleTable({ ...full, scales: [entry(0), bad] }, DEFAULT_GROUPS).rows).toEqual([]);
  });
});

describe("wide CSV", () => {
  const full = fullOf([0, 2, 3, 4, 5, 6]);
  const [head, data] = lines(roiFeatureWideCsv(full, "case1"));
  it("has one row and 36 feature columns in scale-major order, then the per-scale records", () => {
    expect(lines(roiFeatureWideCsv(full)).length).toBe(2);
    const feat = head.filter((c) => /^Scale[0-9.]+mm_(Intensity|Auxiliary)/.test(c));
    expect(feat.length).toBe(36);
    expect(feat[0]).toBe("Scale0mm_IntensityBasedStatistical_Mean");
    expect(feat[6]).toBe("Scale2mm_IntensityBasedStatistical_Mean");
    expect(head.slice(0, 3)).toEqual(["CaseLabel", "Provenance_GraphyNextVersion", "Provenance_RadiomicsJVersion"]);
    expect(head.slice(3, 9)).toEqual(["Roi_InitialVoxels", "Roi_IntensityMaskVoxels", "Roi_MorphMaskVoxels", "Roi_VolumeMm3", "Warning_SmallRoiThresholdVoxels", "Warning_SmallRoi"]);
    expect(head).toContain("Scale2mm_Provenance_SettingsSha256");
    expect(head).toContain("Scale3mm_Filter_SigmaMm");
    expect(head.filter((c) => c.startsWith("Roi_")).length).toBe(4);
    expect(head.every((c) => /^[\x20-\x7e]+$/.test(c))).toBe(true);
    expect(new Set(head).size).toBe(head.length);
    expect(data.length).toBe(head.length);
  });
  it("each cell equals the value of that scale's own result (no row or column mix-up)", () => {
    for (const e of full.scales!) {
      for (let j = 0; j < SIX.length; j++) {
        const i = head.indexOf(`${scalePrefix(e.scaleMm)}${SIX[j]}`);
        expect(Number(data[i])).toBe(100 * e.scaleMm + j);
      }
    }
  });
  it("writes the filter record per scale and none for r=0", () => {
    expect(data[head.indexOf("Scale0mm_Filter_Kind")]).toBe("none");
    expect(data[head.indexOf("Scale3mm_Filter_Kind")]).toBe("LoG");
    expect(data[head.indexOf("Scale3mm_Filter_SigmaMm")]).toBe("1.7321");
    expect(data[head.indexOf("Scale0mm_Filter_SigmaMm")]).toBe("");
  });
  it("keeps the decimal point of r in the names", () => {
    const h = lines(roiFeatureWideCsv(fullOf([0, 2.5])))[0];
    expect(h).toContain("Scale2.5mm_IntensityBasedStatistical_Mean");
  });
  it("writes only the six statistics by default and every common feature on request", () => {
    const f = fullOf([0, 2, 3], [EXTRA]);
    const six = lines(roiFeatureWideCsv(f))[0].filter((c) => c.startsWith("Scale") && /mm_(Intensity|Auxiliary)/.test(c));
    expect(six.length).toBe(18);
    expect(six.some((c) => c.endsWith("Variance"))).toBe(false);
    const all = lines(roiFeatureWideCsv(f, "", DEFAULT_GROUPS, true))[0].filter((c) => /^Scale[0-9.]+mm_(Intensity|Auxiliary)/.test(c));
    expect(all.length).toBe(21);
    expect(lines(roiFeatureWideDefinitionsCsv(f, DEFAULT_GROUPS, true)).length).toBe(lines(roiFeatureWideDefinitionsCsv(f)).length + 3);
  });
  it("two cases have the same columns in the same order", () => {
    const other = lines(roiFeatureWideCsv(fullOf([0, 2, 3, 4, 5, 6]), "case2"))[0];
    expect(other).toEqual(head);
  });
  it("refuses to write when the ROI size differs between scales (negative control)", () => {
    const f = fullOf([0, 3]);
    f.scales![1] = entry(3, [], { ...SIZE, intensityVoxels: 900 });
    expect(() => roiFeatureWideCsv(f)).toThrow(WideCsvError);
    expect(() => roiFeatureWideCsv(f)).toThrow(/Roi_IntensityMaskVoxels/);
  });
  it("refuses an empty result", () => {
    expect(() => roiFeatureWideCsv({ ...fullOf([0]), scales: [] })).toThrow(WideCsvError);
  });
});

describe("wide definitions CSV", () => {
  const full = fullOf([0, 2, 2.5, 3]);
  const rows = lines(roiFeatureWideDefinitionsCsv(full));
  const head = lines(roiFeatureWideCsv(full))[0];
  it("has scale_mm, sigma_mm and group for every scale column and one line per data column", () => {
    expect(rows[0].slice(-3)).toEqual(["scale_mm", "sigma_mm", "group"]);
    expect(rows.slice(1).map((r) => r[0])).toEqual(head);
    const at = (c: string) => rows.find((r) => r[0] === c)!;
    expect(at("Scale2mm_IntensityBasedStatistical_Mean").slice(-3)).toEqual(["2", "1.1547", "fine"]);
    expect(at("Scale0mm_IntensityBasedStatistical_Mean").slice(-3)).toEqual(["0", "", "none"]);
    expect(at("Scale2.5mm_IntensityBasedStatistical_Mean").slice(-1)).toEqual(["ungrouped"]);
    expect(at("Scale3mm_IntensityBasedStatistical_Mean").slice(-1)).toEqual(["medium"]);
    expect(at("Roi_InitialVoxels").slice(-3)).toEqual(["", "", ""]);
  });
  it("changing the groups changes only the group column", () => {
    const g = lines(roiFeatureWideDefinitionsCsv(full, { fine: [2.5], medium: [], coarse: [2, 3] }));
    expect(g.map((r) => r.slice(0, -1))).toEqual(rows.map((r) => r.slice(0, -1)));
    expect(g.find((r) => r[0] === "Scale2.5mm_IntensityBasedStatistical_Mean")!.slice(-1)).toEqual(["fine"]);
  });
});
