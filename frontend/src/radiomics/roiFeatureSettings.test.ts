/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  anyFamilyOn, defaultRoiFeatureForm, parseSigmaList, roiFeatureSettings, ROI_FEATURE_FAMILIES, splitFilteredFamily,
} from "./roiFeatureSettings";
import { discretisationOf } from "./roiFeatureCsv";

/** RadiomicsJ の `SettingParams` の名前（2.4.1 の javap の列挙に、LoG の 3 キー〔2.5.0〜〕を足したもの）。backend はこれ以外を 400 で断る。 */
const SETTING_PARAMS = new Set([
  "INT_label", "INT_interpolation2D", "INT_interpolation_mask2D", "INT_interpolation3D", "INT_interpolation_mask3D",
  "DOUBLE_Mask_PartialVolumeThareshold", "BOOL_interpolation_intensity_rounding",
  "BOOL_USE_FixedBinNumber", "DOUBLE_binWidth", "INT_binCount", "BOOL_normalize", "BOOL_removeOutliers",
  "DOUBLE_zScore", "DOUBLE_normalizeScale", "DOUBLE_densityShift", "DOUBLE_rangeMax", "DOUBLE_rangeMin",
  "INT_IVH_binCount", "DOUBLE_IVH_binWidth", "INT_IVH_MODE", "INT_alpha", "INT_deltaGLCM", "INT_deltaNGTDM",
  "INT_deltaNGLDM", "INT_GLAM_maxRadius", "INT_GLAM_maxReferenceVoxels", "BOOL_GLAM_boundaryCorrection",
  "INT_GLAM_numRandomisations", "LONG_GLAM_randomSeed", "INT_GLAM_savitzkyGolayWindow",
  "INT_GLAM_savitzkyGolayPolynomial", "DOUBLE_GLAM_peakProminence", "INT_GLAM_maxLocalShellRadius",
  "STRING_weightingNorm", "INTARRAY_box_sizes", "DOUBLEARRAY_resamplingFactorXYZ", "BOOL_force2D",
  "BOOL_activate_no_default_features",
  "BOOL_enableIntensityBasedStatistics", "BOOL_enableLocalIntensityFeatures", "BOOL_enableIntensityHistogram",
  "BOOL_enableIntensityVolumeHistogram", "BOOL_enableMorphological", "BOOL_enableShape2D", "BOOL_enableGLCM",
  "BOOL_enableGLRLM", "BOOL_enableGLSZM", "BOOL_enableGLDZM", "BOOL_enableGLAM", "BOOL_enableNGTDM",
  "BOOL_enableNGLDM", "BOOL_enableHomological", "BOOL_enableFractal", "BOOL_enableAuxiliaryStatistics", "BOOL_enableOperationalInfo",
  "BOOL_enableDiagnostics",
  "DOUBLEARRAY_logSigmaMm", "DOUBLE_logTruncate", "STRING_logPadding",
]);

describe("roiFeatureSettings", () => {
  it("既定は RadiomicsJ の既定（ビン数 32、GLAM・Shape2D はオフ、リサンプリングなし）", () => {
    const s = roiFeatureSettings(defaultRoiFeatureForm());
    expect(s.BOOL_USE_FixedBinNumber).toBe("1");
    expect(s.INT_binCount).toBe("32");
    expect(s.DOUBLE_binWidth).toBeUndefined();
    expect(s.DOUBLEARRAY_resamplingFactorXYZ).toBeUndefined();
    expect(s.BOOL_enableGLAM).toBe("0");
    expect(s.BOOL_enableShape2D).toBe("0");
    for (const k of ["Morphological", "GLCM", "GLRLM", "GLSZM", "GLDZM", "NGTDM", "NGLDM", "Fractal",
      "IntensityBasedStatistics", "IntensityHistogram", "IntensityVolumeHistogram", "LocalIntensityFeatures"]) {
      expect(s[`BOOL_enable${k}`]).toBe("1");
    }
  });

  it("送るキーはすべて SettingParams の名前で、患者情報・ラベル・2D は送らない", () => {
    const form = { ...defaultRoiFeatureForm(), resampleMm: 1 };
    for (const s of [roiFeatureSettings(form), roiFeatureSettings({ ...form, fixedBinNumber: false })]) {
      for (const k of Object.keys(s)) expect(SETTING_PARAMS.has(k), k).toBe(true);
      expect(s.BOOL_enableOperationalInfo).toBeUndefined();
      expect(s.INT_label).toBeUndefined();
      expect(s.BOOL_force2D).toBeUndefined();
    }
  });

  it("ビン幅を選ぶとビン幅だけを送る", () => {
    const s = roiFeatureSettings({ ...defaultRoiFeatureForm(), fixedBinNumber: false, binWidth: 12.5 });
    expect(s.BOOL_USE_FixedBinNumber).toBe("0");
    expect(s.DOUBLE_binWidth).toBe("12.5");
    expect(s.INT_binCount).toBeUndefined();
  });

  it("リサンプリングは等方の画素間隔（mm）を 3 つ並べる", () => {
    const s = roiFeatureSettings({ ...defaultRoiFeatureForm(), resampleMm: 0.75 });
    expect(s.DOUBLEARRAY_resamplingFactorXYZ).toBe("0.75,0.75,0.75");
  });

  it("族を全部外すと計算できない", () => {
    const form = defaultRoiFeatureForm();
    expect(anyFamilyOn(form)).toBe(true);
    const none = { ...form, families: Object.fromEntries(ROI_FEATURE_FAMILIES.map((f) => [f.key, false])) };
    expect(anyFamilyOn(none)).toBe(false);
  });
});

describe("LoG フィルタ", () => {
  it("既定ではオフで、フィルタのキーは送らない（従来と同じ要求）", () => {
    const s = roiFeatureSettings(defaultRoiFeatureForm());
    expect(Object.keys(s).filter((k) => /logSigma|logTruncate|logPadding/.test(k))).toEqual([]);
  });

  it("オンなら σ・切り捨て・境界を RadiomicsJ のキーで送る（キーは SettingParams にある）", () => {
    const s = roiFeatureSettings({ ...defaultRoiFeatureForm(), logOn: true, logSigmaMm: "1.5, 2.5", logTruncate: 4, logPadding: "NEAREST" });
    expect(s.DOUBLEARRAY_logSigmaMm).toBe("1.5,2.5");
    expect(s.DOUBLE_logTruncate).toBe("4");
    expect(s.STRING_logPadding).toBe("NEAREST");
    for (const k of Object.keys(s)) expect(SETTING_PARAMS.has(k) || k.startsWith("BOOL_enable")).toBe(true);
  });

  it("σ の検査: 正の数だけ。空・0・負・数でないものは null", () => {
    expect(parseSigmaList("1.5,2.5 3")).toEqual([1.5, 2.5, 3]);
    for (const bad of ["", "  ", "0", "-1", "1,abc", "1,,x", "NaN", "Infinity"]) expect(parseSigmaList(bad)).toBeNull();
  });

  it("フィルタ後の族を σ と元の族に分け、離散化は元の族で判定する", () => {
    expect(splitFilteredFamily("log_sigma1.5mm_GLCM")).toEqual({ sigma: "1.5", base: "GLCM" });
    expect(splitFilteredFamily("GLCM")).toBeNull();
    const d = { fixedBinNumber: true, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 };
    expect(discretisationOf("log_sigma1.5mm_GLCM", d)).toBe("fixedBinNumber=32");
    expect(discretisationOf("log_sigma1.5mm_IntensityBasedStatistical", d)).toBe("");
  });
});
