/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { resolveUsCalibration, type UsRegion } from "./usCalibration";

const region = (o: Partial<UsRegion> = {}): UsRegion => ({
  spatialFormat: 1,
  dataType: 1,
  minX0: 0,
  minY0: 0,
  maxX1: 639,
  maxY1: 479,
  unitsX: 3,
  unitsY: 3,
  deltaX: 0.01,
  deltaY: 0.01,
  ...o,
});

describe("resolveUsCalibration", () => {
  it("one 2-D region in cm gives mm per pixel (x10)", () => {
    const c = resolveUsCalibration([region()]);
    expect(c.source).toBe("us-region");
    expect(c.tier).toBe("calibrated");
    expect(c.mmPerPxCol).toBeCloseTo(0.1, 12);
    expect(c.mmPerPxRow).toBeCloseTo(0.1, 12);
    expect(c.warnings).toEqual([]);
  });

  it("keeps row and column apart when the deltas differ (anisotropic)", () => {
    const c = resolveUsCalibration([region({ deltaX: 0.02, deltaY: 0.03 })]);
    expect(c.mmPerPxCol).toBeCloseTo(0.2, 12);
    expect(c.mmPerPxRow).toBeCloseTo(0.3, 12);
    expect(c.warnings).toContain("anisotropic");
  });

  it("uses the absolute value of a negative delta", () => {
    expect(resolveUsCalibration([region({ deltaY: -0.01 })]).mmPerPxRow).toBeCloseTo(0.1, 12);
  });

  it("ignores M-mode, spectral and non-cm regions", () => {
    const c = resolveUsCalibration([
      region({ spatialFormat: 2 }),
      region({ spatialFormat: 3, unitsX: 4, unitsY: 7 }),
    ]);
    expect(c.tier).toBe("uncalibrated");
    expect(c.mmPerPxCol).toBeNull();
  });

  it("takes a 2-D region even when other kinds of region are present", () => {
    const c = resolveUsCalibration([region({ spatialFormat: 3, unitsX: 4, unitsY: 7, deltaX: 0.5 }), region({ deltaX: 0.02, deltaY: 0.02 })]);
    expect(c.mmPerPxCol).toBeCloseTo(0.2, 12);
  });

  it("applies several 2-D regions only when their spacing agrees", () => {
    expect(resolveUsCalibration([region(), region({ minX0: 320 })]).source).toBe("us-region");
    const c = resolveUsCalibration([region(), region({ deltaX: 0.02, deltaY: 0.02 })]);
    expect(c.tier).toBe("uncalibrated");
    expect(c.warnings).toContain("usRegionsDiffer");
  });

  it("is uncalibrated with no region at all", () => {
    expect(resolveUsCalibration([]).tier).toBe("uncalibrated");
  });
});
