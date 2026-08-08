/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * `regGeometry.ts` の幾何を固定するテスト。
 *
 * <p>ここで守っているのは「index と world の対応」と「範囲外の扱い」。
 * レジストレーションは幾何そのものを推定する処理なので、土台の幾何がずれていると
 * 最適化は**もっともらしく収束したうえで間違った答え**を返す。数値で固定しておく。
 */
import { describe, it, expect } from "vitest";
import {
  bodyMaskIndices,
  buildPyramid,
  centroidOfIndices,
  gaussianSmooth,
  makeVolume,
  sampleTrilinear,
  sampleWorld,
  worldBounds,
  type RegVolume,
} from "./regGeometry";
import type { Vec3 } from "./regTransform";

/** 軸位・等方 1mm・原点中心の小さなボリューム。 */
function axialVolume(nx: number, ny: number, nz: number, fill: (i: number, j: number, k: number) => number): RegVolume {
  const data = new Float32Array(nx * ny * nz);
  let o = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) data[o++] = fill(i, j, k);
    }
  }
  const ipp0: Vec3 = [-(nx - 1) / 2, -(ny - 1) / 2, -(nz - 1) / 2];
  return makeVolume(data, [nx, ny, nz], [1, 0, 0, 0, 1, 0], ipp0, 1, 1, [0, 0, 1]);
}

describe("regGeometry — index と world の対応", () => {
  it("軸位ボリューム: index の中心が world の原点になる", () => {
    const v = axialVolume(9, 9, 9, () => 0);
    expect(sampleWorld(v, 0, 0, 0)).toBe(0); // 範囲内（NaN でない）
    const b = worldBounds(v);
    expect(b.min).toEqual([-4, -4, -4]);
    expect(b.max).toEqual([4, 4, 4]);
  });

  it("矢状（sagittal）でも world 座標が正しく出る", () => {
    // IOP = 列が +y(後)、行が +z(頭) 方向、スライスは +x(左) 方向へ進む。
    const nx = 5, ny = 5, nz = 5;
    const data = new Float32Array(nx * ny * nz);
    data[2 * nx * ny + 2 * nx + 2] = 100; // index (2,2,2)
    const v = makeVolume(data, [nx, ny, nz], [0, 1, 0, 0, 0, 1], [10, -2, -2], 1, 1, [1, 0, 0]);
    // index (2,2,2) → world = ipp0 + 2*col(+y) + 2*row(+z) + 2*slice(+x)
    expect(sampleWorld(v, 12, 0, 0)).toBeCloseTo(100, 6);
    // 1 voxel ずれれば値は落ちる（幾何が効いていることの確認）
    expect(sampleWorld(v, 12, 1, 0)).toBeCloseTo(0, 6);
  });

  it("スライス間隔は法線ではなく渡された IPP 差に従う（ギャップのあるスタック）", () => {
    const v = makeVolume(new Float32Array(2 * 2 * 3), [2, 2, 3], [1, 0, 0, 0, 1, 0], [0, 0, 0], 1, 1, [0, 0, 5]);
    expect(v.spacing[2]).toBe(5);
    expect(worldBounds(v).max[2]).toBe(10); // (3-1) * 5
  });
});

describe("regGeometry — サンプリング", () => {
  it("trilinear が格子点で厳密、格子間で線形になる", () => {
    // x 方向に 0,10,20,... の勾配
    const v = axialVolume(4, 2, 2, (i) => i * 10);
    expect(sampleTrilinear(v, 1, 0, 0)).toBeCloseTo(10, 6);
    expect(sampleTrilinear(v, 1.5, 0, 0)).toBeCloseTo(15, 6);
    expect(sampleTrilinear(v, 2.25, 0, 0)).toBeCloseTo(22.5, 6);
  });

  it("★範囲外は NaN で、0 では埋めない", () => {
    const v = axialVolume(4, 4, 4, () => 42);
    expect(Number.isNaN(sampleTrilinear(v, -0.01, 0, 0))).toBe(true);
    expect(Number.isNaN(sampleTrilinear(v, 3.01, 0, 0))).toBe(true);
    expect(Number.isNaN(sampleWorld(v, 100, 0, 0))).toBe(true);
    // 0 埋めしていると「視野外」と「値が 0 の実体」が区別できなくなる。
    expect(sampleTrilinear(v, 3, 3, 3)).toBe(42);
  });
});

describe("regGeometry — Gaussian 平滑", () => {
  it("総和を保つ（正規化されたカーネル・カーネルが内部に収まる場合）", () => {
    // カーネル半径 (=3σ=4) が端に掛からない位置にインパルスを置く。端に掛かると
    // 端複製で裾が切れて総和が落ちるが、それは境界の性質であって正規化の話ではない。
    const n = 16;
    const dims = [n, n, n] as const;
    const data = new Float32Array(n * n * n);
    data[8 * n * n + 8 * n + 8] = 1000;
    const out = gaussianSmooth(data, dims, [1.2, 1.2, 1.2]);
    const before = data.reduce((s, v) => s + v, 0);
    const after = out.reduce((s, v) => s + v, 0);
    expect(after).toBeCloseTo(before, 2);
  });

  it("一様な領域は平滑しても値が変わらない（端複製の確認込み）", () => {
    // 一様入力なら端でも値は保存される。境界の扱いが「端複製」であることの確認。
    const dims = [8, 8, 8] as const;
    const out = gaussianSmooth(new Float32Array(512).fill(30), dims, [2, 2, 2]);
    for (const v of out) expect(v).toBeCloseTo(30, 4);
  });

  it("σ=0 は入力のコピーを返す（入力を破壊しない）", () => {
    const dims = [4, 4, 4] as const;
    const data = new Float32Array(64).fill(7);
    const out = gaussianSmooth(data, dims, [0, 0, 0]);
    expect(Array.from(out)).toEqual(Array.from(data));
    out[0] = 999;
    expect(data[0]).toBe(7);
  });

  it("軸ごとに独立に効く（x だけ平滑すると y の分布は変わらない）", () => {
    const dims = [9, 9, 1] as const;
    const data = new Float32Array(81);
    data[4 * 9 + 4] = 100;
    const out = gaussianSmooth(data, dims, [1.5, 0, 0]);
    // 中心行は広がる
    expect(out[4 * 9 + 3]).toBeGreaterThan(0);
    // 隣の行はゼロのまま（y 方向には広がっていない）
    expect(out[3 * 9 + 4]).toBe(0);
  });
});

describe("regGeometry — ピラミッド", () => {
  it("等方・世界軸平行の段ができ、間隔が指定どおりになる", () => {
    const v = axialVolume(32, 32, 32, (i, j, k) => (i > 8 && i < 24 && j > 8 && j < 24 && k > 8 && k < 24 ? 100 : -1000));
    const pyr = buildPyramid(v, [8, 4, 2]);
    expect(pyr.map((p) => p.spacingMm)).toEqual([8, 4, 2]);
    for (const lvl of pyr) {
      expect(lvl.volume.spacing).toEqual([lvl.spacingMm, lvl.spacingMm, lvl.spacingMm]);
      // 世界軸平行 = index→world の回転部が対角
      const m = lvl.volume.indexToWorld;
      expect(m[1]).toBe(0); expect(m[2]).toBe(0);
      expect(m[4]).toBe(0); expect(m[6]).toBe(0);
      expect(m[8]).toBe(0); expect(m[9]).toBe(0);
    }
    // 粗い段ほどボクセル数が少ない
    const counts = pyr.map((p) => p.volume.data.length);
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
  });

  it("斜め（oblique）入力でも段は世界軸平行になる", () => {
    // 45 度回した軸位。
    const s = Math.SQRT1_2;
    const data = new Float32Array(16 * 16 * 4).fill(50);
    const v = makeVolume(data, [16, 16, 4], [s, s, 0, -s, s, 0], [-8, -8, -2], 1, 1, [0, 0, 1]);
    const [lvl] = buildPyramid(v, [4]);
    const m = lvl.volume.indexToWorld;
    expect(m[0]).toBe(4);
    expect(m[1]).toBe(0);
    expect(m[4]).toBe(0);
    expect(m[5]).toBe(4);
  });

  it("各段は元のボリュームから作る（段を重ねて誤差を積まない）", () => {
    // 一様な値なら、どの段でも（範囲内は）その値のままになるはず。
    const v = axialVolume(24, 24, 24, () => 123);
    const pyr = buildPyramid(v, [8, 4, 2]);
    for (const lvl of pyr) {
      const finite = Array.from(lvl.volume.data).filter((x) => Number.isFinite(x));
      expect(finite.length).toBeGreaterThan(0);
      for (const x of finite) expect(x).toBeCloseTo(123, 3);
    }
  });
});

describe("regGeometry — ボディマスク", () => {
  it("空気を除いた索引が返り、重心が中身の中心に来る", () => {
    // 中央 8^3 だけ中身、まわりは空気。
    const v = axialVolume(24, 24, 24, (i, j, k) =>
      i >= 8 && i < 16 && j >= 8 && j < 16 && k >= 8 && k < 16 ? 200 : -1000);
    const idx = bodyMaskIndices(v);
    expect(idx.length).toBe(8 * 8 * 8);
    const c = centroidOfIndices(v, idx);
    // index 8..15 の中心 = 11.5 → world = 11.5 - 11.5 = 0
    expect(c[0]).toBeCloseTo(0, 6);
    expect(c[1]).toBeCloseTo(0, 6);
    expect(c[2]).toBeCloseTo(0, 6);
  });

  it("閾値はモダリティ非依存（PET 様の 0..5 のスケールでも機能する）", () => {
    const v = axialVolume(20, 20, 20, (i, j, k) =>
      i >= 5 && i < 15 && j >= 5 && j < 15 && k >= 5 && k < 15 ? 4.2 : 0.01);
    const idx = bodyMaskIndices(v);
    expect(idx.length).toBe(10 * 10 * 10);
  });

  it("一様なボリュームでは母集団を返さない（空）", () => {
    const v = axialVolume(8, 8, 8, () => 5);
    expect(bodyMaskIndices(v).length).toBe(0);
  });
});
