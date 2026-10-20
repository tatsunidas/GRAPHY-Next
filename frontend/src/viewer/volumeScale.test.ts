/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { MIN_SLAB_MM, finestVoxelMm, tooFineForVolumeRendering } from "./volumeScale";

const layout = (ps: number, dz: number, n = 5) => ({
  pixelSpacingRow: ps,
  pixelSpacingCol: ps,
  zSpatial: Array.from({ length: n }, (_, z) => ({ z, imagePositionPatient: [0, 0, z * dz] as [number, number, number] })),
});

describe("tooFineForVolumeRendering", () => {
  it("ライブラリの最小のスラブは 0.05 mm", () => {
    expect(MIN_SLAB_MM).toBe(0.05);
  });
  it("顕微鏡（0.33 µm・2 µm）は細かすぎる、CT・MR は描ける", () => {
    expect(tooFineForVolumeRendering(layout(0.000332, 0.002))).toBe(true);
    expect(finestVoxelMm(layout(0.000332, 0.002))).toBeCloseTo(0.000332, 9);
    expect(tooFineForVolumeRendering(layout(0.7, 0.625))).toBe(false);
    expect(tooFineForVolumeRendering(layout(0.05, 0.05))).toBe(false); // ちょうど最小値は描ける
    expect(tooFineForVolumeRendering(layout(0.3, 0.02))).toBe(true); // Z だけ細かい
    expect(tooFineForVolumeRendering(null)).toBe(false);
  });
});
