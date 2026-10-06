import { describe, expect, it } from "vitest";
import { NIFTI_UNIT_OPTIONS, niftiUnitCode } from "./niftiUnits";

describe("niftiUnitCode", () => {
  it("maps fixed choices to UCUM codes", () => {
    expect(niftiUnitCode("none", "")).toBe("1");
    expect(niftiUnitCode("mm2s", "ignored")).toBe("mm2/s");
    expect(niftiUnitCode("hu", "")).toBe("[hnsf'U]");
    expect(niftiUnitCode("suv", "")).toBe("{SUVbw}g/ml");
  });

  it("takes a trimmed custom code and refuses what DICOM cannot hold", () => {
    expect(niftiUnitCode("other", "  10*-3.mm2/s ")).toBe("10*-3.mm2/s");
    expect(niftiUnitCode("other", "")).toBeNull();
    expect(niftiUnitCode("other", "x".repeat(17))).toBeNull();
    expect(niftiUnitCode("other", String.raw`a\b`)).toBeNull();
  });

  it("has a label key for every choice", () => {
    for (const o of NIFTI_UNIT_OPTIONS) expect(o.labelKey.startsWith("nifti.unit.")).toBe(true);
  });
});
