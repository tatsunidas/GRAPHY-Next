/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H33（マスク → メッシュ・計測）。marching cubes と計測は本体の実装をそのまま通すので、
 * ここで確かめるのは **繋ぎ方**（幾何の分解・セグメントの分離・返す量の意味）である。
 */
import { describe, expect, it } from "vitest";
import { geomFromIndexToWorld, measureMask, type PluginMaskInput } from "./pluginMeshApi";

const DIMS: [number, number, number] = [32, 32, 32];
const SPACING = 2;
/** 単位行列 × spacing、原点は患者座標で (-31, -31, -31)。 */
const INDEX_TO_WORLD = [
  SPACING, 0, 0, -31,
  0, SPACING, 0, -31,
  0, 0, SPACING, -31,
  0, 0, 0, 1,
];

function emptyMask(): PluginMaskInput {
  return {
    data: new Uint8Array(DIMS[0] * DIMS[1] * DIMS[2]),
    dims: DIMS,
    indexToWorld: INDEX_TO_WORLD,
  };
}

function sphere(mask: PluginMaskInput, centre: [number, number, number], radius: number, value: number) {
  const [nx, ny] = DIMS;
  for (let z = 0; z < DIMS[2]; z++) {
    for (let y = 0; y < DIMS[1]; y++) {
      for (let x = 0; x < DIMS[0]; x++) {
        const d2 = (x - centre[0]) ** 2 + (y - centre[1]) ** 2 + (z - centre[2]) ** 2;
        if (d2 <= radius * radius) mask.data[x + y * nx + z * nx * ny] = value;
      }
    }
  }
}

describe("geomFromIndexToWorld", () => {
  it("行列を origin / spacing / direction に分解する", () => {
    const geom = geomFromIndexToWorld(DIMS, INDEX_TO_WORLD);
    expect(geom).not.toBeNull();
    expect(geom!.origin).toEqual([-31, -31, -31]);
    expect(geom!.spacing).toEqual([SPACING, SPACING, SPACING]);
    expect(geom!.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("斜めの向きでも列が単位方向になる", () => {
    // x 軸を 45 度倒した向き（間隔 2）。
    const s = Math.SQRT1_2 * 2;
    const geom = geomFromIndexToWorld(DIMS, [s, 0, 0, 0, s, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    expect(geom).not.toBeNull();
    expect(geom!.spacing[0]).toBeCloseTo(2, 6);
    // 列 0 = (1/√2, 1/√2, 0)
    expect(geom!.direction[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(geom!.direction[3]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("幾何として成立しないものは null（でっち上げない）", () => {
    expect(geomFromIndexToWorld(DIMS, [])).toBeNull();
    // 間隔 0 の軸がある
    expect(geomFromIndexToWorld(DIMS, [0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])).toBeNull();
  });
});

describe("measureMask", () => {
  it("球の体積が理論値に近い（本体の marching cubes をそのまま通している）", () => {
    const mask = emptyMask();
    const radiusVox = 8;
    sphere(mask, [16, 16, 16], radiusVox, 1);
    const [m] = measureMask(mask);

    const analyticMm3 = (4 / 3) * Math.PI * (radiusVox * SPACING) ** 3;
    // ボクセル数の体積は階段状に数えるので理論値の近くに来る。
    expect(m.voxelVolumeMm3 / analyticMm3).toBeGreaterThan(0.9);
    expect(m.voxelVolumeMm3 / analyticMm3).toBeLessThan(1.1);
    // 🔴 メッシュ体積は平滑化で角が落ちるぶん小さく出る。**一致しないのが正常**。
    expect(m.meshVolumeMm3).toBeGreaterThan(0);
    expect(m.meshVolumeMm3).toBeLessThan(m.voxelVolumeMm3);
    expect(m.meshVolumeMm3 / analyticMm3).toBeGreaterThan(0.8);
    expect(m.numTriangles).toBeGreaterThan(100);
    // 主径は直径 32mm の球なので 3 軸ともその近く。
    for (const d of m.diameters) expect(d).toBeGreaterThan(0.8 * 2 * radiusVox * SPACING);
    expect(m.meshVolumeMl).toBeCloseTo(m.meshVolumeMm3 / 1000, 9);
  });

  it("🔴 セグメントごとに別のメッシュにする（1 つに融合させない）", () => {
    const mask = emptyMask();
    sphere(mask, [8, 8, 8], 5, 1);
    sphere(mask, [24, 24, 24], 3, 2);
    const results = measureMask(mask);

    expect(results.map((r) => r.segment)).toEqual([1, 2]);
    // 大きい方が大きい。融合していたら両方が同じ（合計）値になる。
    expect(results[0].voxelCount).toBeGreaterThan(results[1].voxelCount);
    expect(results[0].meshVolumeMm3).toBeGreaterThan(results[1].meshVolumeMm3);
    // 別々のかたまりなので AABB は重ならない。
    expect(results[0].boundsMax[0]).toBeLessThan(results[1].boundsMin[0]);
  });

  it("患者座標で返す（origin が効いている）", () => {
    const mask = emptyMask();
    sphere(mask, [16, 16, 16], 6, 1);
    const [m] = measureMask(mask);
    // index 16 → world -31 + 16*2 = 1。半径 12mm なので概ね [-11, 13]。
    expect(m.boundsMin[0]).toBeGreaterThan(-16);
    expect(m.boundsMin[0]).toBeLessThan(-6);
    expect(m.boundsMax[0]).toBeGreaterThan(6);
    expect(m.boundsMax[0]).toBeLessThan(16);
  });

  it("空のセグメントは消さずに 0 で返す（測れなかったことが分かる）", () => {
    const mask = emptyMask();
    sphere(mask, [16, 16, 16], 5, 1);
    const results = measureMask(mask, { segments: [1, 7] });
    expect(results.map((r) => r.segment)).toEqual([1, 7]);
    expect(results[1].voxelCount).toBe(0);
    expect(results[1].numTriangles).toBe(0);
  });

  it("大きさが合わない入力は空配列（黙って一部を測らない）", () => {
    expect(measureMask({ data: new Uint8Array(10), dims: DIMS, indexToWorld: INDEX_TO_WORLD })).toEqual([]);
    expect(measureMask({ ...emptyMask(), indexToWorld: [1, 2, 3] })).toEqual([]);
  });
});
