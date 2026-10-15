/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { rasterizeSphereToLabelVolume } from "./sphereRaster";
import { countForeground, voxelVolumeMm3, type VolumeGeom } from "./labelVolume";

const geom = (spacing: [number, number, number], dims: [number, number, number] = [41, 41, 41], direction = [1, 0, 0, 0, 1, 0, 0, 0, 1]): VolumeGeom => ({
  dims, spacing, origin: [0, 0, 0], direction,
});

describe("rasterizeSphereToLabelVolume", () => {
  it("voxel volume is close to 4/3 pi r^3 (anisotropic grid)", () => {
    const g = geom([1, 1, 2], [41, 41, 21]);
    const r = 15;
    const lv = rasterizeSphereToLabelVolume(g, [20, 20, 20], r)!;
    const exact = (4 / 3) * Math.PI * r ** 3;
    expect(Math.abs(voxelVolumeMm3(lv) - exact) / exact).toBeLessThan(0.03);
    expect(voxelVolumeMm3(lv)).toBe(countForeground(lv) * 2);
  });

  it("is exactly symmetric about a voxel-centred sphere", () => {
    const g = geom([1, 1, 1]);
    const lv = rasterizeSphereToLabelVolume(g, [20, 20, 20], 6.3)!;
    const at = (i: number, j: number, k: number) => lv.data[(k * 41 + j) * 41 + i];
    for (let d = 0; d <= 8; d++) {
      expect(at(20 + d, 20, 20)).toBe(at(20 - d, 20, 20));
      expect(at(20, 20 + d, 20)).toBe(at(20, 20 - d, 20));
      expect(at(20, 20, 20 + d)).toBe(at(20, 20, 20 - d));
    }
    expect(at(20, 20, 20)).toBe(1);
    expect(at(20 + 7, 20, 20)).toBe(0);
  });

  it("follows an oblique direction and returns null for degenerate input", () => {
    const c = Math.SQRT1_2;
    const g = geom([1, 1, 1], [41, 41, 41], [c, -c, 0, c, c, 0, 0, 0, 1]);
    const lv = rasterizeSphereToLabelVolume(g, [0, 28, 20], 6)!;
    const exact = (4 / 3) * Math.PI * 216;
    expect(Math.abs(countForeground(lv) - exact) / exact).toBeLessThan(0.05);
    expect(rasterizeSphereToLabelVolume(g, [0, 0, 0], 0)).toBeNull();
    expect(rasterizeSphereToLabelVolume(g, [1000, 1000, 1000], 3)).toBeNull();
  });
});
