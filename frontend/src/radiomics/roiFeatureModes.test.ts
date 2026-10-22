/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRow } from "../api";
import {
  compareRows,
  discretisationOf2d,
  roiFeature2dFiles,
  roiFeatureAggregateCsv,
  roiFeatureSectionCsv,
  roiFeatureSlicesCsv,
} from "./roiFeatureModes";
import { roiFeatureDataCsv } from "./roiFeatureCsv";

const row = (column: string, v: number | null, ibsi: string | null = null): RoiFeatureRow => {
  const i = column.indexOf("_");
  return { column, family: column.slice(0, i), feature: column.slice(i + 1), ibsi, value: v, notes: [] };
};
const prov = {
  graphyNextVersion: "1.0", radiomicsjVersion: "2.4.1", extractedAt: "2026-10-22T00:00:00Z", settingsSha256: "ab".repeat(32),
};
const disc = { fixedBinNumber: true, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 };
const rec = { computedAt: "2026-10-22T00:00:00Z", discretisation: disc, provenance: prov, settingsProperties: "BOOL_force2D=1\n" };

const MEAN = "IntensityBasedStatistical_Mean";
const full = (): RoiFeatureResult => ({
  radiomicsjVersion: "2.4.1", computedAt: "2026-10-22T00:00:00Z", fromCache: false, label: 1,
  rows: [row("Morphology_VolumeMesh", 416.2, "RNU0"), row(MEAN, 175, "Q4LE")],
  discretisation: disc, provenance: prov, settingsProperties: "x=1\n",
  roiSize: {
    initialVoxels: 400, intensityVoxels: 400, morphVoxels: 400, volumeMm3: 1, smallRoiWarnVoxels: null, smallRoi: null,
  },
  lossyCompressed: false,
  section: {
    fromCache: false, positionMm: 2, areaMm2: 147, pixels: 300,
    rows: [row("Shape2D_PixelSurface", 147), row(MEAN, 200, "Q4LE")],
    record: rec,
    roiSize: {
      initialVoxels: 300, intensityVoxels: 300, morphVoxels: null, volumeMm3: null, smallRoiWarnVoxels: 150, smallRoi: false,
    },
  },
  slices: {
    fromCache: false,
    rows: [
      { positionMm: 0, pixels: 100, areaMm2: 49, rows: [row(MEAN, 100)] },
      { positionMm: 2, pixels: 300, areaMm2: 147, rows: [row(MEAN, 200)] },
    ],
    failures: [{ positionMm: 4, reason: "x" }],
    mean: [row(MEAN, 150)],
    pixelWeightedMean: [row(MEAN, 175)],
    slicesUsed: { [MEAN]: 2 },
    foregroundSlices: 3,
    record: rec, smallRoiWarnPixels: null, smallRoiPositionsMm: [],
  },
});

describe("compareRows", () => {
  it("3 単位を 1 つの表に並べ、計算しない単位は undefined", () => {
    const rows = compareRows(full());
    const mean = rows.find((r) => r.column === MEAN)!;
    expect([mean.whole, mean.section, mean.sliceMean, mean.sliceWeighted]).toEqual([175, 200, 150, 175]);
    const morph = rows.find((r) => r.column === "Morphology_VolumeMesh")!;
    expect(morph.whole).toBe(416.2);
    expect(morph.section).toBeUndefined();
    expect(morph.sliceMean).toBeUndefined();
    const s2d = rows.find((r) => r.column === "Shape2D_PixelSurface")!;
    expect(s2d.whole).toBeUndefined();
    expect(s2d.section).toBe(147);
    // 3D の行が先、3D に無い列は後ろ
    expect(rows.map((r) => r.column)).toEqual(["Morphology_VolumeMesh", MEAN, "Shape2D_PixelSurface"]);
  });

  it("3D だけなら 2D の列はすべて undefined", () => {
    const r = full();
    r.section = null;
    r.slices = null;
    expect(compareRows(r).every((x) => x.section === undefined && x.sliceMean === undefined)).toBe(true);
  });
});

describe("2D の CSV", () => {
  it("3D の CSV は 2D を選んでも一字も変わらない", () => {
    const a = full();
    const b = full();
    b.section = null;
    b.slices = null;
    expect(roiFeatureDataCsv(a, "c1")).toBe(roiFeatureDataCsv(b, "c1"));
  });

  it("最大断面の CSV: 記録 5 列・大きさ 6 列・最大断面 3 列・特徴。Morphology の列は無い", () => {
    const [h, v] = roiFeatureSectionCsv(full().section!, "c1").trimEnd().split("\r\n");
    const cols = h.split(",");
    expect(cols.slice(0, 5)).toEqual([
      "CaseLabel", "Provenance_GraphyNextVersion", "Provenance_RadiomicsJVersion", "Provenance_ExtractedAt",
      "Provenance_SettingsSha256",
    ]);
    expect(cols.slice(11, 14)).toEqual(["Section_PositionMm", "Section_AreaMm2", "Section_Pixels"]);
    expect(cols.slice(14)).toEqual(["Shape2D_PixelSurface", MEAN]);
    const vals = v.split(",");
    expect(vals.length).toBe(cols.length);
    expect(vals[0]).toBe("c1");
    expect(Number(vals[12])).toBe(147);
    expect(Number(vals[vals.length - 1])).toBe(200);
    // 形態の体積は 2D では無いので大きさの列は NaN、しきい値は 150
    expect(vals[7]).toBe("NaN");
    expect(vals[9]).toBe("150");
  });

  it("スライス別の CSV: 前景のあるスライスごとに 1 行（失敗は行にならない）", () => {
    const lines = roiFeatureSlicesCsv(full().slices!, "c1").trimEnd().split("\r\n");
    expect(lines.length).toBe(1 + 2);
    const h = lines[0].split(",");
    expect(h.slice(5, 8)).toEqual(["Slice_PositionMm", "Slice_AreaMm2", "Slice_Pixels"]);
    expect(lines.slice(1).map((l) => Number(l.split(",")[5]))).toEqual([0, 2]);
    expect(lines.slice(1).map((l) => Number(l.split(",")[h.indexOf(MEAN)]))).toEqual([100, 200]);
  });

  it("集約の CSV: mean・pixelWeightedMean・slicesUsed と、前景数・失敗数", () => {
    const lines = roiFeatureAggregateCsv(full().slices!, "c1").trimEnd().split("\r\n");
    expect(lines.length).toBe(4);
    const h = lines[0].split(",");
    const at = h.indexOf(MEAN);
    const byAgg = Object.fromEntries(lines.slice(1).map((l) => {
      const c = l.split(",");
      return [c[h.indexOf("Aggregate")], c];
    }));
    expect(Number(byAgg.mean[at])).toBe(150);
    expect(Number(byAgg.pixelWeightedMean[at])).toBe(175);
    expect(Number(byAgg.slicesUsed[at])).toBe(2);
    expect(byAgg.mean[h.indexOf("Slices_Foreground")]).toBe("3");
    expect(byAgg.mean[h.indexOf("Slices_Failed")]).toBe("1");
  });

  it("書き出すファイルは選んだ単位のぶんだけ", () => {
    expect(roiFeature2dFiles(full(), "c1").map((f) => f.suffix)).toEqual([
      "_maxsection2d.csv", "_maxsection2d_definitions.csv", "_maxsection2d_radiomicsj.properties",
      "_slices2d.csv", "_slices2d_aggregate.csv", "_slices2d_definitions.csv", "_slices2d_radiomicsj.properties",
    ]);
    const r = full();
    r.section = null;
    expect(roiFeature2dFiles(r, "").map((f) => f.suffix).every((s) => s.startsWith("_slices2d"))).toBe(true);
    r.slices = null;
    expect(roiFeature2dFiles(r, "")).toEqual([]);
  });

  it("定義表の離散化に per-slice が付く（IVH は付かない）", () => {
    expect(discretisationOf2d("GLCM", disc)).toBe("fixedBinNumber=32;scope=per-slice");
    expect(discretisationOf2d("IntensityVolumeHistogram", disc)).toBe("ivhMode=0;ivhBinCount=1000;ivhBinWidth=2.5");
    expect(discretisationOf2d("Diagnostics", disc)).toBe("");
  });
});
