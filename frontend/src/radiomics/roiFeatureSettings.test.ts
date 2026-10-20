/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { anyFamilyOn, defaultRoiFeatureForm, roiFeatureSettings, ROI_FEATURE_FAMILIES } from "./roiFeatureSettings";

/** RadiomicsJ 2.4.1 の `SettingParams` の名前（javap で列挙）。backend はこれ以外を 400 で断る。 */
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
  "BOOL_enableNGLDM", "BOOL_enableHomological", "BOOL_enableFractal", "BOOL_enableOperationalInfo",
  "BOOL_enableDiagnostics",
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
