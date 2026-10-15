/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { roiVolumeFromSlices, type VolumeMeshSlice } from "./roiVolumeMesh";
import { sliceGeometry } from "./sliceGeometry";

function circle(w: number, h: number, cx: number, cy: number, r: number, hole = 0): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d <= r * r && (hole === 0 || d > hole * hole)) a[y * w + x] = 1;
  }
  return a;
}
const sl = (labels: Uint8Array, widthMm: number): VolumeMeshSlice => ({ labels, width: 64, height: 64, colSpacingMm: 1.5, rowSpacingMm: 1.5, widthMm });

describe("roiVolumeFromSlices", () => {
  it("等間隔のファントム（円柱 r=8 を 3 枚、1.5×1.5×3 mm）は 591 ボクセル × 6.75 = 3989.25 mm³", () => {
    const c = circle(64, 64, 20, 22, 8);
    const r = roiVolumeFromSlices([sl(c, 3), sl(c, 3), sl(c, 3)]);
    expect(r.voxels).toBe(591);
    expect(r.volumeMm3).toBeCloseTo(3989.25, 9);
  });
  it("穴のある形でも、断面積 = 画素数 × 画素の面積（穴は引く）", () => {
    const d = circle(64, 64, 32, 32, 12, 5);
    const r = roiVolumeFromSlices([sl(d, 2)]);
    const n = d.reduce((a, v) => a + v, 0);
    expect(r.areasMm2[0]).toBeCloseTo(n * 2.25, 9);
    expect(r.volumeMm3).toBeCloseTo(n * 2.25 * 2, 9);
  });
  it("角だけで接する画素も、それぞれの面積を足す", () => {
    const a = new Uint8Array(64 * 64);
    a[0] = 1; a[65] = 1;
    expect(roiVolumeFromSlices([sl(a, 1)]).areasMm2[0]).toBeCloseTo(2 * 2.25, 9);
  });
  it("不均一な並び（31.4 / 55.4 / 61.4）は、スライスごとの幅 [24, 15, 6] で数える", () => {
    const g = sliceGeometry([31.4243, 55.4243, 61.4243].map((z, i) => ({ id: `${i}`, ipp: [0, 0, z], iop: [1, 0, 0, 0, 1, 0] })));
    const c = circle(64, 64, 20, 22, 8);
    const r = roiVolumeFromSlices(g.widths.map((w) => sl(c, w)));
    expect(r.volumeMm3).toBeCloseTo(197 * 2.25 * (24 + 15 + 6), 6);
  });
  it("segment を指定すると、その番号だけを数える", () => {
    const a = new Uint8Array(64 * 64);
    a[0] = 1; a[1] = 2; a[2] = 2;
    const r = roiVolumeFromSlices([sl(a, 1)], 2);
    expect(r.voxels).toBe(2);
    expect(r.volumeMm3).toBeCloseTo(2 * 2.25, 9);
  });
});
