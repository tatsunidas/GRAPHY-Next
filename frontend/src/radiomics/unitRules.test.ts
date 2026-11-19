import { describe, expect, it } from "vitest";

import { FAMILY_UNITS, familyUnits } from "./unitRules";
import { ROI_FEATURE_FAMILIES } from "./roiFeatureSettings";

describe("族 × 単位の規則", () => {
  it("形態・GLAM は 3D のみ、Shape2D は 2D のみ、ほかは両方", () => {
    expect(familyUnits("Morphology")).toEqual({ in3d: true, in2d: false });
    expect(familyUnits("GLAM")).toEqual({ in3d: true, in2d: false });
    expect(familyUnits("Shape2D")).toEqual({ in3d: false, in2d: true });
    for (const f of ["GLCM", "GLRLM", "GLSZM", "GLDZM", "NGTDM", "NGLDM", "IntensityBasedStatistical", "IntensityHistogram", "IntensityVolumeHistogram", "LocalIntensity", "Fractal", "AuxiliaryStatistics"]) {
      expect(familyUnits(f)).toEqual({ in3d: true, in2d: true });
    }
  });
  it("表のキーは、画面の族の一覧にある（綴りの食い違いを検出）", () => {
    const keys = new Set(ROI_FEATURE_FAMILIES.map((f) => f.key));
    for (const k of Object.keys(FAMILY_UNITS)) expect(keys.has(k)).toBe(true);
  });
});
