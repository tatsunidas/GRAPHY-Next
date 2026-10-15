/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { geomFromImageData, imageDataFromGeom, transposeDirection, voxelToWorld, worldToVoxel, type VolumeGeom } from "./labelVolume";

type V3 = [number, number, number];
const unit = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// 実データ（約 1.5° 傾いた横断）と同じ IOP。
const row = unit([1.0, 0.026, -0.001]);
const col = unit(cross(cross(row, [-0.026, 0.999, -0.025]), row));
const normal = cross(row, col);
const origin: V3 = [-69.0861, -45.33453, -38.388];
const spacing: V3 = [0.29296875, 0.29296875, 6];
const ipp = (k: number): V3 => [origin[0] + normal[0] * spacing[2] * k, origin[1] + normal[1] * spacing[2] * k, origin[2] + normal[2] * spacing[2] * k];

/** 表示の体積（vtk / Cornerstone）と同じ並び: 先頭 3 つが i 軸。 */
const vtkLike = {
  getDimensions: () => [512, 512, 16],
  getSpacing: () => spacing,
  getOrigin: () => origin,
  getDirection: () => [...row, ...col, ...normal],
};

describe("direction at the vtk boundary", () => {
  it("geomFromImageData: each slice's IPP maps back to (0, 0, k) on a tilted series", () => {
    const g = geomFromImageData(vtkLike)!;
    for (let k = 0; k < 16; k++) {
      const v = worldToVoxel(g, ipp(k));
      expect(Math.abs(v[0])).toBeLessThan(1e-6);
      expect(Math.abs(v[1])).toBeLessThan(1e-6);
      expect(v[2]).toBeCloseTo(k, 6);
    }
  });

  it("reading the vtk order as-is puts tilted slices off the plane (the old bug)", () => {
    const g = geomFromImageData(vtkLike)!;
    const asIs: VolumeGeom = { ...g, direction: transposeDirection(g.direction) };
    expect(Math.abs(worldToVoxel(asIs, ipp(15))[1])).toBeGreaterThan(0.5);
  });

  it("imageDataFromGeom: vtk's indexToWorld agrees with voxelToWorld", () => {
    const g = geomFromImageData(vtkLike)!;
    const small: VolumeGeom = { ...g, dims: [4, 5, 6] };
    const id = imageDataFromGeom(small, new Uint8Array(4 * 5 * 6));
    for (const [i, j, k] of [[0, 0, 0], [3, 0, 0], [0, 4, 0], [0, 0, 5], [3, 4, 5]] as V3[]) {
      const a = id.indexToWorld([i, j, k], [0, 0, 0]) as number[];
      const b = voxelToWorld(small, i, j, k);
      for (let c = 0; c < 3; c++) expect(a[c]).toBeCloseTo(b[c], 4);
    }
  });
});
