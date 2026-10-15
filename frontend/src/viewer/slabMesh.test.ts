/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { closedMeshVolume, slabMesh, slabRanges, type SlabMeshResult } from "./slabMesh";
import { roiVolumeFromSlices } from "./roiVolumeMesh";
import { sliceGeometry, regularGrid } from "./sliceGeometry";

/** 各辺を共有する三角形の数がすべて偶数（＝穴の無い閉じた面）。角だけで接する所は 4 になる。 */
function watertight(m: SlabMeshResult): boolean {
  const count = new Map<string, number>();
  const t = m.triangles;
  for (let i = 0; i < t.length; i += 3) {
    for (const [a, b] of [[t[i], t[i + 1]], [t[i + 1], t[i + 2]], [t[i + 2], t[i]]]) {
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  return [...count.values()].every((c) => c % 2 === 0);
}

describe("slabMesh", () => {
  it("1 画素・1 層は箱 1 つ（12 三角形）。体積 = 画素の面積 × 幅、外向き（正）", () => {
    const m = slabMesh([1], [1, 1, 1], 1.5, 2, [{ z0: -3, z1: 3 }]);
    expect(m.triangles.length / 3).toBe(12);
    expect(closedMeshVolume(m)).toBeCloseTo(1.5 * 2 * 6, 9);
    expect(watertight(m)).toBe(true);
  });

  it("ドーナツ・角だけで接する画素・複数の層でも閉じていて、体積が roiVolumeFromSlices と一致する", () => {
    const nx = 6, ny = 6;
    const slice = (rows: string[]) => Uint8Array.from(rows.join("").split("").map((c) => (c === "#" ? 1 : 0)));
    const a = slice(["......", ".###..", ".#.#..", ".###..", "....#.", "......"]);
    const b = slice(["......", "..##..", "..##..", "......", "....#.", ".....#"]);
    const labels = new Uint8Array(nx * ny * 2);
    labels.set(a, 0);
    labels.set(b, nx * ny);
    const ranges = [{ z0: -2, z1: 4 }, { z0: 4, z1: 7 }]; // 幅 6 と 3（範囲の違う層が接する）
    const m = slabMesh(labels, [nx, ny, 2], 0.5, 0.5, ranges);
    expect(watertight(m)).toBe(true);
    const want = roiVolumeFromSlices([
      { labels: a, width: nx, height: ny, colSpacingMm: 0.5, rowSpacingMm: 0.5, widthMm: 6 },
      { labels: b, width: nx, height: ny, colSpacingMm: 0.5, rowSpacingMm: 0.5, widthMm: 3 },
    ]).volumeMm3;
    expect(closedMeshVolume(m)).toBeCloseTo(want, 9);
  });

  it("均一な格子では各層 ±s/2。3 層の円柱は厚み 3 × s、体積はボクセル数 × ボクセル体積", () => {
    const nx = 5, ny = 5, nz = 3;
    const labels = new Uint8Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) labels[k * 25 + 12] = 1;
    const ranges = slabRanges(nz, 3);
    const m = slabMesh(labels, [nx, ny, nz], 1.5, 1.5, ranges);
    const zs = Array.from(m.points).filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(9, 9);
    expect(closedMeshVolume(m)).toBeCloseTo(3 * 1.5 * 1.5 * 3, 9);
  });
});

describe("slabRanges（補間した格子）", () => {
  // 実例: 31.4 / 55.4 / 61.4。格子は 6 mm・6 層、元のスライスは 0・4・5 層目。
  const g = sliceGeometry([31.4243, 55.4243, 61.4243].map((z, i) => ({ id: `${i}`, ipp: [0, 0, z], iop: [1, 0, 0, 0, 1, 0] })));
  const grid = regularGrid(g);
  const rel = g.positions.map((p) => p - g.positions[0]);
  const ranges = slabRanges(grid.count, grid.spacing, { gridIndexOf: grid.gridIndexOf, positions: rel });

  it("元のスライスの範囲は前後との中点まで。端の外側は最小の間隔の半分。幅は [15, 15, 6]", () => {
    const w = [0, 4, 5].map((k) => ranges[k]!.z1 - ranges[k]!.z0);
    expect(w.map((x) => Math.round(x * 1000) / 1000)).toEqual([15, 15, 6]);
  });
  it("同じ体積から作った ROI は、画像の範囲（先頭の中心 − 3 mm 〜 末尾の中心 + 3 mm）からはみ出さない", () => {
    const labels = new Uint8Array(6);
    for (const k of [0, 4, 5]) labels[k] = 1;
    const m = slabMesh(labels, [1, 1, 6], 1, 1, ranges);
    const zs = Array.from(m.points).filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(0 - 3 - 1e-9);
    expect(Math.max(...zs)).toBeLessThanOrEqual(30 + 3 + 1e-9);
  });
  it("幅は sliceGeometry.widths と一致する（見た目と体積が同じ形）", () => {
    const w = [0, 4, 5].map((k) => ranges[k]!.z1 - ranges[k]!.z0);
    w.forEach((x, i) => expect(x).toBeCloseTo(g.widths[i], 9));
  });
  it("元のスライスでない層は範囲を持たず、面を出さない", () => {
    expect([1, 2, 3].map((k) => ranges[k])).toEqual([null, null, null]);
    const labels = new Uint8Array(6);
    labels[2] = 1; // 補間で作った層（2 層目）の画素
    expect(slabMesh(labels, [1, 1, 6], 1, 1, ranges).triangles.length).toBe(0);
  });
  it("3 枚目だけ塗った ROI は、幅 6 mm の板になる（見た目と体積が一致）", () => {
    const labels = new Uint8Array(6);
    labels[5] = 1;
    const m = slabMesh(labels, [1, 1, 6], 0.4688, 0.4688, ranges);
    const zs = Array.from(m.points).filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(6, 6);
    expect(closedMeshVolume(m)).toBeCloseTo(0.4688 * 0.4688 * 6, 9);
  });
});
