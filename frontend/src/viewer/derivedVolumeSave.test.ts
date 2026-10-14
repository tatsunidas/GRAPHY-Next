/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { buildDerivedVolumeRequest } from "./derivedVolumeSave";
import { GRID_EDGE_TOLERANCE, axisGrid, resampleToGrid } from "./gridResample";
import { makeVolume } from "./regGeometry";

const th = (20 * Math.PI) / 180;
const IOP = [Math.cos(th), Math.sin(th), 0, -Math.sin(th), Math.cos(th), 0];
const IPP0: [number, number, number] = [-5, 7, 3];

function source(fn: (i: number, j: number, k: number) => number) {
  const nx = 12, ny = 10, nz = 6;
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[k * nx * ny + j * nx + i] = fn(i, j, k);
  return makeVolume(data, [nx, ny, nz], IOP, IPP0, 0.7, 0.8, [0, 0, 2.5]);
}

function decode(pixels: string): Int16Array {
  const bin = atob(pixels);
  const u8 = new Uint8Array(bin.length);
  for (let n = 0; n < bin.length; n++) u8[n] = bin.charCodeAt(n);
  return new Int16Array(u8.buffer);
}

function build(opts: { suvScale?: number | null; fn?: (i: number, j: number, k: number) => number } = {}) {
  const src = source(opts.fn ?? ((i, j, k) => i + 2 * j + 3 * k));
  const grid = axisGrid(src, [1.0, 0.5, 1.0]);
  const data = resampleToGrid(src, null, grid, GRID_EDGE_TOLERANCE);
  const req = buildDerivedVolumeRequest({
    grid, data, studyUid: "S", seriesUid: "E", seriesDescription: "d", derivationDescription: "x",
    sourceSliceThickness: 5, suvScale: opts.suvScale, background: -1000,
  });
  return { src, grid, data, req };
}

describe("buildDerivedVolumeRequest", () => {
  it("IPP は 原点 + k·s·法線、IOP は元と一致する", () => {
    const { grid, req } = build();
    expect(req.frames.length).toBe(grid.dims[2]);
    req.frames.forEach((f, k) => {
      expect(f.instanceNumber).toBe(k + 1);
      expect(f.imagePositionPatient[0]).toBeCloseTo(IPP0[0], 9);
      expect(f.imagePositionPatient[1]).toBeCloseTo(IPP0[1], 9);
      expect(f.imagePositionPatient[2]).toBeCloseTo(IPP0[2] + k * 1.0, 9);
    });
    req.imageOrientationPatient.forEach((v, n) => expect(Math.abs(v - IOP[n])).toBeLessThan(1e-6));
  });

  it("pixelSpacing は [行間隔, 列間隔]、spacingBetweenSlices は s_k、厚みは元の値", () => {
    const { req, grid } = build();
    expect(req.pixelSpacing).toEqual([0.5, 1.0]);
    expect(req.spacingBetweenSlices).toBe(1.0);
    expect(req.sliceThickness).toBe(5);
    expect(req.rows).toBe(grid.dims[1]);
    expect(req.columns).toBe(grid.dims[0]);
  });

  it("画素と rescale から元の値が量子化の半刻み以内で復元できる", () => {
    const { req, data, grid } = build();
    const per = grid.dims[0] * grid.dims[1];
    let max = 0;
    req.frames.forEach((f, k) => {
      const px = decode(f.pixels);
      for (let n = 0; n < per; n++) {
        max = Math.max(max, Math.abs(px[n] * req.rescaleSlope + req.rescaleIntercept - data[k * per + n]));
      }
    });
    expect(max).toBeLessThanOrEqual(req.rescaleSlope / 2 + 1e-6);
  });

  it("SUV 校正あり: 乗数で割り戻した値（Bq/mL）が保存される", () => {
    const { req, data } = build({ suvScale: 0.25 });
    const px = decode(req.frames[0].pixels);
    const v = px[5] * req.rescaleSlope + req.rescaleIntercept;
    expect(Math.abs(v - data[5] / 0.25)).toBeLessThanOrEqual(req.rescaleSlope / 2 + 1e-6);
    // 【負例】割り戻さない値とは一致しない（テストに検出力がある）
    expect(Math.abs(v - data[5])).toBeGreaterThan(req.rescaleSlope);
  });

  it("NaN は背景で埋め、PixelPaddingValue に記録する／背景が無いと拒否", () => {
    const src = source(() => 1);
    const grid = axisGrid(src, [1, 1, 1]);
    const data = new Float32Array(grid.dims[0] * grid.dims[1] * grid.dims[2]).fill(5);
    data[0] = NaN;
    const base = { grid, data, studyUid: "S", seriesUid: "E", seriesDescription: "d", derivationDescription: "x" };
    const req = buildDerivedVolumeRequest({ ...base, background: -3 });
    expect(req.pixelPaddingValue).not.toBeNull();
    expect(decode(req.frames[0].pixels)[0]).toBe(req.pixelPaddingValue);
    expect(() => buildDerivedVolumeRequest({ ...base, background: NaN })).toThrow();
  });
});
