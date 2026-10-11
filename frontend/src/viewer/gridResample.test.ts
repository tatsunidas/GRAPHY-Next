/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 格子の再サンプル。真値は世界座標の 1 次関数 v = a·x + b·y + c·z + d
 * （trilinear は 1 次関数を範囲内で厳密に再現するので、出力の各点の真値は出力 IPP から決まる）。
 */
import { describe, expect, it } from "vitest";
import { GRID_EDGE_TOLERANCE, axisGrid, estimateGridBytes, isotropicGrid, resampleToGrid, type Grid } from "./gridResample";
import { makeVolume, type RegVolume } from "./regGeometry";

const A = 0.5, B = -0.25, C = 0.125, D = 10;
const f = (x: number, y: number, z: number) => A * x + B * y + C * z + D;

/** 斜位（面内 20° 回転）。列 0.7・行 0.8・スライス 2.5 mm。tilt=true で sliceStep を法線から傾ける。 */
function phantom(opts: { nz?: number; tilt?: boolean } = {}): RegVolume {
  const nx = 30, ny = 25, nz = opts.nz ?? 12;
  const th = (20 * Math.PI) / 180;
  const rc: [number, number, number] = [Math.cos(th), Math.sin(th), 0];
  const rr: [number, number, number] = [-Math.sin(th), Math.cos(th), 0];
  const nrm: [number, number, number] = [0, 0, 1];
  const step: [number, number, number] = opts.tilt
    ? [2.5 * Math.sin(0.3) * rc[0], 2.5 * Math.sin(0.3) * rc[1], 2.5 * Math.cos(0.3)]
    : [0, 0, 2.5];
  const ipp0: [number, number, number] = [-5, 7, 3];
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = ipp0[0] + rc[0] * 0.7 * i + rr[0] * 0.8 * j + step[0] * k;
    const y = ipp0[1] + rc[1] * 0.7 * i + rr[1] * 0.8 * j + step[1] * k;
    const z = ipp0[2] + rc[2] * 0.7 * i + rr[2] * 0.8 * j + step[2] * k;
    data[k * nx * ny + j * nx + i] = f(x, y, z);
  }
  void nrm;
  return makeVolume(data, [nx, ny, nz], [...rc, ...rr], ipp0, 0.7, 0.8, step);
}

function worldOf(g: Grid, i: number, j: number, k: number): [number, number, number] {
  const m = g.indexToWorld;
  return [
    m[0] * i + m[1] * j + m[2] * k + m[3],
    m[4] * i + m[5] * j + m[6] * k + m[7],
    m[8] * i + m[9] * j + m[10] * k + m[11],
  ];
}

function maxErr(g: Grid, data: Float32Array): { max: number; nan: number } {
  const [nx, ny, nz] = g.dims;
  let max = 0, nan = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = data[k * nx * ny + j * nx + i];
    if (Number.isNaN(v)) { nan++; continue; }
    const [x, y, z] = worldOf(g, i, j, k);
    max = Math.max(max, Math.abs(v - f(x, y, z)));
  }
  return { max, nan };
}

describe("isotropicGrid", () => {
  it("dims・原点・向きが解析値と一致する（斜位）", () => {
    const src = phantom();
    const g = isotropicGrid(src, 1.0);
    // L = (n-1)*間隔: 列 29*0.7=20.3, 行 24*0.8=19.2, スライス 11*2.5=27.5
    expect(g.dims).toEqual([21, 20, 28]);
    const th = (20 * Math.PI) / 180;
    const m = g.indexToWorld;
    expect([m[3], m[7], m[11]]).toEqual([-5, 7, 3]);
    expect(m[0]).toBeCloseTo(Math.cos(th), 12);
    expect(m[4]).toBeCloseTo(Math.sin(th), 12);
    expect(m[1]).toBeCloseTo(-Math.sin(th), 12);
    expect(m[5]).toBeCloseTo(Math.cos(th), 12);
    expect(m[10]).toBeCloseTo(1, 12);
    expect(g.spacing).toEqual([1, 1, 1]);
  });

  it("worldToIndex は indexToWorld の逆", () => {
    const g = isotropicGrid(phantom({ tilt: true }), 0.9);
    const [x, y, z] = worldOf(g, 3, 4, 5);
    const w = g.worldToIndex;
    expect(w[0] * x + w[1] * y + w[2] * z + w[3]).toBeCloseTo(3, 9);
    expect(w[4] * x + w[5] * y + w[6] * z + w[7]).toBeCloseTo(4, 9);
    expect(w[8] * x + w[9] * y + w[10] * z + w[11]).toBeCloseTo(5, 9);
  });

  it("チルトでも出力は法線方向に直交した格子（列・行・法線が互いに直交）", () => {
    const g = isotropicGrid(phantom({ tilt: true }), 1);
    const m = g.indexToWorld;
    const col = [m[0], m[4], m[8]], row = [m[1], m[5], m[9]], sl = [m[2], m[6], m[10]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(col, row)).toBeCloseTo(0, 12);
    expect(dot(col, sl)).toBeCloseTo(0, 12);
    expect(dot(row, sl)).toBeCloseTo(0, 12);
  });

  it("1 次関数を再現し、元の範囲内（斜位）では NaN が 0 個", () => {
    const src = phantom();
    const g = isotropicGrid(src, 1.0);
    const { max, nan } = maxErr(g, resampleToGrid(src, null, g, GRID_EDGE_TOLERANCE));
    expect(nan).toBe(0);
    expect(max).toBeLessThan(1e-4);
  });

  it("許容 0 の既定では縁が NaN になりうる（許容が必要な理由。既定の挙動は従来どおり）", () => {
    const src = phantom();
    const g = isotropicGrid(src, 1.0);
    expect(maxErr(g, resampleToGrid(src, null, g)).nan).toBeGreaterThan(0);
  });

  it("間隔を元の間隔にそろえても末尾が NaN にならない", () => {
    const src = phantom();
    for (const s of [0.7, 0.8, 2.5]) {
      const g = isotropicGrid(src, s);
      const { nan } = maxErr(g, resampleToGrid(src, null, g, GRID_EDGE_TOLERANCE));
      expect(nan).toBe(0);
    }
    const g = axisGrid(src, [0.7, 0.8, 2.5]);
    expect(g.dims).toEqual([30, 25, 12]);
  });

  it("軸ごとの間隔で [列, 行, スライス] の順が正しい", () => {
    const src = phantom();
    const g = axisGrid(src, [1.4, 0.4, 5]);
    expect(g.dims).toEqual([Math.floor(20.3 / 1.4 + 1e-9) + 1, Math.floor(19.2 / 0.4 + 1e-9) + 1, Math.floor(27.5 / 5 + 1e-9) + 1]);
    const { max, nan } = maxErr(g, resampleToGrid(src, null, g, GRID_EDGE_TOLERANCE));
    expect(nan).toBe(0);
    expect(max).toBeLessThan(1e-4);
  });

  it("チルト: 有限値の画素は真値に一致し、はみ出した角は NaN（0 で埋めない）", () => {
    const src = phantom({ tilt: true });
    const g = isotropicGrid(src, 1.0);
    const out = resampleToGrid(src, null, g, GRID_EDGE_TOLERANCE);
    const { max, nan } = maxErr(g, out);
    expect(max).toBeLessThan(1e-4);
    expect(nan).toBeGreaterThan(0);
    expect(out.filter((v) => v === 0).length).toBe(0);
  });

  it("【負例】間隔の [行,列] を入れ替えた格子は 1 次関数が合わない（検出力の確認）", () => {
    const src = phantom();
    const good = axisGrid(src, [1.4, 0.4, 2.5]);
    // 取り違え: 列と行の間隔を逆にした格子を、正しい幾何のつもりで評価する
    const bad = axisGrid(src, [0.4, 1.4, 2.5]);
    // bad の出力値を good の幾何で真値と比べると合わない
    const dataBad = resampleToGrid(src, null, bad, GRID_EDGE_TOLERANCE);
    const wrong = { ...good, dims: bad.dims } as Grid;
    const { max } = maxErr(wrong, dataBad);
    expect(max).toBeGreaterThan(0.01);
    // 同じ検査で正しい格子は通る
    expect(maxErr(good, resampleToGrid(src, null, good, GRID_EDGE_TOLERANCE)).max).toBeLessThan(1e-4);
  });

  it("s=0・負・NaN・Infinity は例外", () => {
    const src = phantom();
    for (const s of [0, -1, NaN, Infinity]) {
      expect(() => isotropicGrid(src, s)).toThrow();
    }
    expect(() => axisGrid(src, [1, 0, 1])).toThrow();
  });

  it("estimateGridBytes は Float32 の大きさ", () => {
    expect(estimateGridBytes({ dims: [10, 20, 30] })).toBe(24000);
  });
});
