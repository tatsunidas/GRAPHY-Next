/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン host API のリサンプル（H21）。
 *
 * <p>ここが狂うと「位置合わせは合っているのに値が別の場所から来る」という、
 * **画面では気付けない**壊れ方をする。真値が閉じた式で書ける格子で固定する。
 */
import { describe, expect, it } from "vitest";
import { resamplePluginVolume } from "./pluginResample";
import { linearTransform, mat4Identity } from "../viewer/regTransform";
import type { PluginVolume, PluginVolumeGrid } from "./pluginTypes";

/** 軸平行・等方の格子（index → world は原点 ＋ 間隔）。 */
function grid(dims: [number, number, number], spacing: number, origin: [number, number, number]) {
  const m = [
    spacing, 0, 0, origin[0],
    0, spacing, 0, origin[1],
    0, 0, spacing, origin[2],
    0, 0, 0, 1,
  ];
  const inv = [
    1 / spacing, 0, 0, -origin[0] / spacing,
    0, 1 / spacing, 0, -origin[1] / spacing,
    0, 0, 1 / spacing, -origin[2] / spacing,
    0, 0, 0, 1,
  ];
  return {
    dims,
    spacing: [spacing, spacing, spacing] as [number, number, number],
    indexToWorld: m,
    worldToIndex: inv,
  } satisfies PluginVolumeGrid;
}

function volume(g: PluginVolumeGrid, fill: (i: number, j: number, k: number) => number): PluginVolume {
  const [nx, ny, nz] = g.dims;
  const data = new Float32Array(nx * ny * nz);
  let o = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[o++] = fill(i, j, k);
  return {
    ...g,
    data,
    ipp: [g.indexToWorld[3], g.indexToWorld[7], g.indexToWorld[11]],
    iop: [1, 0, 0, 0, 1, 0],
    sliceStep: [0, 0, g.spacing[2]],
    frameOfReferenceUid: "1.2.3",
    modality: "CT",
    unit: "HU",
    sliceThickness: g.spacing[2],
    seriesUid: "s",
    studyUid: "st",
  };
}

describe("プラグイン向けリサンプル（H21）", () => {
  const src = grid([4, 4, 4], 2, [0, 0, 0]);
  // 値 = world x 座標（どこから引いてきたかが値で分かる）。
  const source = volume(src, (i) => i * 2);

  it("★ 変換なしなら同じ格子で値が変わらない", () => {
    const out = resamplePluginVolume(source, null, src);
    expect(Array.from(out.data.slice(0, 4))).toEqual([0, 2, 4, 6]);
    expect(out.dims).toEqual([4, 4, 4]);
  });

  it("★ 別格子（細かい格子）へ引き直せる（値は world 座標に従う）", () => {
    const fine = grid([7, 1, 1], 1, [0, 0, 0]);
    const out = resamplePluginVolume(source, null, fine);
    // world x = 0,1,2,...,6 → 値も同じ（線形補間）。
    expect(Array.from(out.data)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("★ 平行移動の変換が値の引き先を動かす（向きは target→source の pull-back）", () => {
    const m = mat4Identity();
    m[3] = 2; // x に +2mm
    const t = linearTransform(m, { dof: 6, center: [0, 0, 0] });
    const out = resamplePluginVolume(source, t, src);
    // target の x=0 は source の x=2 を引く。
    expect(out.data[0]).toBeCloseTo(2, 6);
    expect(out.data[1]).toBeCloseTo(4, 6);
  });

  it("★ 範囲外は NaN（0 で埋めない＝「視野の外」と「空気」を混同しない）", () => {
    const outside = grid([2, 1, 1], 1, [100, 0, 0]);
    const out = resamplePluginVolume(source, null, outside);
    expect(Number.isNaN(out.data[0])).toBe(true);
  });

  it("出力は目標格子の幾何を持つ（元の幾何を引きずらない）", () => {
    const target = grid([2, 2, 2], 5, [10, 20, 30]);
    const out = resamplePluginVolume(source, null, target);
    expect(out.spacing).toEqual([5, 5, 5]);
    expect(out.ipp).toEqual([10, 20, 30]);
    expect(out.indexToWorld).toEqual(target.indexToWorld);
    // 由来のメタ（単位・モダリティ）は保つ。
    expect(out.unit).toBe("HU");
    expect(out.modality).toBe("CT");
  });
});
