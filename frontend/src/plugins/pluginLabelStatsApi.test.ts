import { describe, expect, it } from "vitest";
import { measureLabels, type PluginLabelInput } from "./pluginLabelStatsApi";
import type { PluginVolume } from "./pluginTypes";

/** 間隔 (sx, sy, sz) の格子。cols は index 軸の方向 × 間隔（斜めの格子は skewZ で k 軸を x に倒す）。 */
function grid(dims: [number, number, number], sx: number, sy: number, sz: number, skewZ = 0) {
  const indexToWorld = [sx, 0, skewZ, 10, 0, sy, 0, -20, 0, 0, sz, 30, 0, 0, 0, 1];
  return { dims, indexToWorld };
}

function volume(g: ReturnType<typeof grid>, value: (i: number, j: number, k: number) => number): PluginVolume {
  const [nx, ny, nz] = g.dims;
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[i + nx * j + nx * ny * k] = value(i, j, k);
  return {
    ...g,
    spacing: [Math.hypot(g.indexToWorld[0], g.indexToWorld[4], g.indexToWorld[8]), Math.hypot(g.indexToWorld[1], g.indexToWorld[5], g.indexToWorld[9]), Math.hypot(g.indexToWorld[2], g.indexToWorld[6], g.indexToWorld[10])],
    worldToIndex: [],
    data,
    ipp: [10, -20, 30],
    iop: [1, 0, 0, 0, 1, 0],
    sliceStep: [g.indexToWorld[2], g.indexToWorld[6], g.indexToWorld[10]],
    frameOfReferenceUid: null,
    modality: "CT",
    unit: "HU",
    sliceThickness: null,
    seriesUid: "s",
    studyUid: "t",
  };
}

function labels(g: ReturnType<typeof grid>, label: (i: number, j: number, k: number) => number): PluginLabelInput {
  const [nx, ny, nz] = g.dims;
  const data = new Uint16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[i + nx * j + nx * ny * k] = label(i, j, k);
  return { ...g, data };
}

const inBox = (i: number, j: number, k: number, lo: number[], hi: number[]) =>
  i >= lo[0] && i <= hi[0] && j >= lo[1] && j <= hi[1] && k >= lo[2] && k <= hi[2];

describe("measureLabels (H66)", () => {
  // 10×10×6 格子・間隔 0.5×0.8×2.5 mm。ラベル 1 = 4×3×2 の直方体、ラベル 300 = 1 ボクセル
  const g = grid([10, 10, 6], 0.5, 0.8, 2.5);
  const lab = labels(g, (i, j, k) => (inBox(i, j, k, [2, 3, 1], [5, 5, 2]) ? 1 : i === 9 && j === 9 && k === 5 ? 300 : 0));
  const vol = volume(g, (i) => i * 10 - 100);

  it("volume is voxel count × voxel volume", () => {
    const r = measureLabels(lab, vol);
    expect(r.map((x) => x.label)).toEqual([1, 300]);
    expect(r[0].voxelCount).toBe(24);
    expect(r[0].volumeMm3).toBeCloseTo(24 * 0.5 * 0.8 * 2.5, 9);
    expect(r[0].volumeMl).toBeCloseTo(0.024, 12);
    expect(r[0].kRange).toEqual([1, 2]);
    expect(r[0].unit).toBe("HU");
  });

  it("value statistics match hand calculation", () => {
    const s = measureLabels(lab, vol)[0].stats!;
    // i = 2..5 → 値 -80,-70,-60,-50（各 6 ボクセル）
    expect(s.n).toBe(24);
    expect(s.mean).toBeCloseTo(-65, 9);
    expect(s.min).toBe(-80);
    expect(s.max).toBe(-50);
    expect(s.median).toBeCloseTo(-65, 9);
    expect(s.sd).toBeCloseTo(Math.sqrt((15 ** 2 + 5 ** 2 + 5 ** 2 + 15 ** 2) / 4), 6);
  });

  it("centroid is in patient LPS mm", () => {
    const c = measureLabels(lab, vol)[0].centroidLps;
    // index の重心 (3.5, 4, 1.5)
    expect(c[0]).toBeCloseTo(10 + 3.5 * 0.5, 9);
    expect(c[1]).toBeCloseTo(-20 + 4 * 0.8, 9);
    expect(c[2]).toBeCloseTo(30 + 1.5 * 2.5, 9);
  });

  it("slice area is pixel count × pixel area, with value-range areas", () => {
    const r = measureLabels(lab, vol, {
      slices: [1, 4],
      valueRanges: [{ name: "low", min: -80, max: -70 }, { name: "none", min: 500, max: 600 }],
    })[0];
    expect(r.slices[0].k).toBe(1);
    expect(r.slices[0].pixelCount).toBe(12);
    expect(r.slices[0].areaCm2).toBeCloseTo((12 * 0.5 * 0.8) / 100, 12);
    expect(r.slices[0].mean).toBeCloseTo(-65, 9);
    expect(r.slices[0].rangeAreasCm2.low).toBeCloseTo((6 * 0.4) / 100, 12);
    expect(r.slices[0].rangeAreasCm2.none).toBe(0);
    expect(r.slices[1].pixelCount).toBe(0);
    expect(r.slices[1].mean).toBeNaN();
  });

  it("muscle and fat HU ranges count the right pixels", () => {
    const g2 = grid([4, 1, 1], 1, 1, 1);
    const hu = [-190, -30, -29, 150];
    const r = measureLabels(labels(g2, () => 1), volume(g2, (i) => hu[i]), {
      slices: [0],
      valueRanges: [{ name: "muscle", min: -29, max: 150 }, { name: "fat", min: -190, max: -30 }],
    })[0];
    expect(r.slices[0].rangeAreasCm2.muscle).toBeCloseTo(0.02, 12);
    expect(r.slices[0].rangeAreasCm2.fat).toBeCloseTo(0.02, 12);
  });

  it("erosion drops the boundary voxels (6-neighbourhood)", () => {
    const g3 = grid([5, 5, 5], 1, 1, 1);
    const r = measureLabels(labels(g3, (i, j, k) => (inBox(i, j, k, [1, 1, 1], [3, 3, 3]) ? 1 : 0)), volume(g3, (i, j, k) => (i === 2 && j === 2 && k === 2 ? 40 : 0)), { erodeVoxels: 1 })[0];
    expect(r.voxelCount).toBe(27);
    expect(r.eroded!.n).toBe(1);
    expect(r.eroded!.mean).toBe(40);
    expect(measureLabels(lab, vol, { erodeVoxels: 1 })[0].eroded).toBeNull();
  });

  it("uses the triple product on a skewed grid", () => {
    const gs = grid([3, 3, 3], 1, 1, 2, 1.5);
    const r = measureLabels(labels(gs, () => 1), volume(gs, () => 0), { slices: [0] })[0];
    expect(r.volumeMm3).toBeCloseTo(27 * 2, 9);
    expect(r.slices[0].areaCm2).toBeCloseTo(0.09, 12);
  });

  it("only measures requested labels and skips empty ones", () => {
    expect(measureLabels(lab, vol, { labels: [300, 7, 0] }).map((x) => x.label)).toEqual([300]);
  });

  it("refuses a grid that does not match the volume", () => {
    const shifted = { ...lab, indexToWorld: lab.indexToWorld.map((v, i) => (i === 3 ? v + 0.5 : v)) };
    expect(() => measureLabels(shifted, vol)).toThrow(/does not match/);
    const smaller = labels(grid([10, 10, 5], 0.5, 0.8, 2.5), () => 1);
    expect(() => measureLabels(smaller, vol)).toThrow();
  });
});
