/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H41（`pluginCenterlineApi.ts`）の検証。
 *
 * 細線化そのものは `skeletonize.ts` が Fiji と数値一致することで担保されているので、
 * ここで見るのは**公開の契約**だけ:
 * 既知の形（直管・L 字・Y 字）で枝の数と長さが合うか、フレームが正規直交か、
 * そして 🔴 **曲線をはみ出すフレームを返さない**か。
 */
import { describe, expect, it } from "vitest";

import {
  extractCenterline,
  sampleCenterlineFrames,
  type PluginCenterlineGraph,
} from "./pluginCenterlineApi";
import type { PluginMaskInput } from "./pluginMeshApi";
import type { Vec3 } from "../viewer/reslice";

const DIMS: [number, number, number] = [40, 40, 40];
/** 1 mm 等方・軸に平行・原点 0 の格子（index = mm）。 */
const IDENTITY_MM: number[] = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function emptyMask(dims: [number, number, number] = DIMS): PluginMaskInput {
  const [nx, ny, nz] = dims;
  return { data: new Uint8Array(nx * ny * nz), dims, indexToWorld: IDENTITY_MM };
}

/** (x0..x1, y0..y1, z0..z1) の直方体を value で塗る（端点を含む）。 */
function fillBox(
  m: PluginMaskInput,
  x0: number, x1: number,
  y0: number, y1: number,
  z0: number, z1: number,
  value = 1,
): void {
  const [nx, ny] = m.dims;
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        m.data[z * nx * ny + y * nx + x] = value;
      }
    }
  }
}

function totalBranchLength(g: PluginCenterlineGraph): number {
  return g.branches.reduce((a, b) => a + b.lengthMm, 0);
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe("extractCenterline", () => {
  it("直管から 1 本の枝を出し、長さが管の長さに見合う", () => {
    const m = emptyMask();
    // x=5..34（30 ボクセル）、断面 3x3 の直管。
    fillBox(m, 5, 34, 19, 21, 19, 21);
    const g = extractCenterline(m);
    expect(g).not.toBeNull();
    const graph = g!;
    expect(graph.branches).toHaveLength(1);
    // 骨格は端が少し縮むので、管長 29mm に対して緩めに見る。
    expect(totalBranchLength(graph)).toBeGreaterThan(20);
    expect(totalBranchLength(graph)).toBeLessThanOrEqual(30);
    // 端点 2 つ。
    expect(graph.nodes.filter((n) => n.degree === 1)).toHaveLength(2);
  });

  it("Y 字から 3 本の枝と 1 つの分岐点を出す", () => {
    const m = emptyMask();
    fillBox(m, 5, 20, 19, 21, 19, 21); // 幹
    fillBox(m, 20, 32, 19, 21, 19, 21); // 直進する枝
    fillBox(m, 20, 22, 19, 21, 21, 33); // 上へ折れる枝
    const g = extractCenterline(m, { pruneMinLengthMm: 1 });
    expect(g).not.toBeNull();
    const graph = g!;
    expect(graph.branches.length).toBeGreaterThanOrEqual(3);
    expect(graph.nodes.some((n) => n.degree >= 3)).toBe(true);
  });

  it("枝の制御点は患者座標で、格子の中にある", () => {
    const m = emptyMask();
    fillBox(m, 5, 34, 19, 21, 19, 21);
    const graph = extractCenterline(m)!;
    for (const b of graph.branches) {
      expect(b.pointsWorld.length).toBeGreaterThanOrEqual(2);
      for (const p of b.pointsWorld) {
        expect(p).toHaveLength(3);
        expect(p.every((c) => Number.isFinite(c))).toBe(true);
        expect(p[0]).toBeGreaterThanOrEqual(0);
        expect(p[0]).toBeLessThanOrEqual(DIMS[0]);
      }
    }
  });

  it("segment を指定すると、その番号だけを骨格化する", () => {
    const m = emptyMask();
    fillBox(m, 5, 34, 19, 21, 19, 21, 1); // セグメント 1
    fillBox(m, 5, 34, 30, 32, 30, 32, 2); // 離れたセグメント 2
    const both = extractCenterline(m)!;
    const only1 = extractCenterline(m, { segment: 1 })!;
    expect(both.branches.length).toBeGreaterThan(only1.branches.length);
    expect(only1.branches).toHaveLength(1);
  });

  it("前景が無ければ null（空のグラフを返さない）", () => {
    expect(extractCenterline(emptyMask())).toBeNull();
  });

  it("data の長さが dims と合わなければ null", () => {
    const m = emptyMask();
    expect(extractCenterline({ ...m, data: new Uint8Array(10) })).toBeNull();
  });

  it("indexToWorld が壊れていれば null", () => {
    const m = emptyMask();
    fillBox(m, 5, 34, 19, 21, 19, 21);
    expect(extractCenterline({ ...m, indexToWorld: [1, 2, 3] })).toBeNull();
  });
});

describe("sampleCenterlineFrames", () => {
  /** x 軸に沿った長さ 100mm の直線。 */
  const straight: Vec3[] = [
    [0, 0, 0],
    [50, 0, 0],
    [100, 0, 0],
  ];

  it("等間隔・弧長昇順で返す", () => {
    const f = sampleCenterlineFrames(straight, { spacingMm: 10, count: 5 });
    expect(f).toHaveLength(5);
    for (let i = 1; i < f.length; i++) {
      expect(f[i].arcLengthMm - f[i - 1].arcLengthMm).toBeCloseTo(10, 6);
      expect(f[i].arcLengthMm).toBeGreaterThan(f[i - 1].arcLengthMm);
    }
  });

  it("フレームは正規直交", () => {
    const f = sampleCenterlineFrames(straight, { spacingMm: 10, count: 5 });
    for (const fr of f) {
      expect(norm(fr.tangent)).toBeCloseTo(1, 6);
      expect(norm(fr.normal)).toBeCloseTo(1, 6);
      expect(norm(fr.binormal)).toBeCloseTo(1, 6);
      expect(dot(fr.tangent, fr.normal)).toBeCloseTo(0, 6);
      expect(dot(fr.tangent, fr.binormal)).toBeCloseTo(0, 6);
      expect(dot(fr.normal, fr.binormal)).toBeCloseTo(0, 6);
    }
  });

  it("anchorWorld に最も近い位置を中心に配る", () => {
    const f = sampleCenterlineFrames(straight, {
      spacingMm: 10,
      count: 3,
      anchorWorld: [30, 5, 0], // 曲線上の (30,0,0) が最近傍
    });
    expect(f).toHaveLength(3);
    expect(f[1].positionWorld[0]).toBeCloseTo(30, 0);
  });

  it("🔴 曲線をはみ出す位置は返さない（端に丸めない）", () => {
    // 全長 100mm。中心 50 から 25mm 間隔で 9 本 = -50..150 を要求する。
    const f = sampleCenterlineFrames(straight, { spacingMm: 25, count: 9 });
    expect(f.length).toBeLessThan(9);
    for (const fr of f) {
      expect(fr.arcLengthMm).toBeGreaterThanOrEqual(0);
      expect(fr.arcLengthMm).toBeLessThanOrEqual(100);
    }
    // 残ったものは等間隔のまま。
    for (let i = 1; i < f.length; i++) {
      expect(f[i].arcLengthMm - f[i - 1].arcLengthMm).toBeCloseTo(25, 6);
    }
  });

  it("既定は 1 本・曲線の中央", () => {
    const f = sampleCenterlineFrames(straight, { spacingMm: 10 });
    expect(f).toHaveLength(1);
    expect(f[0].arcLengthMm).toBeCloseTo(50, 6);
  });

  it("入力が不正なら空配列", () => {
    expect(sampleCenterlineFrames([[0, 0, 0]], { spacingMm: 10 })).toEqual([]);
    expect(sampleCenterlineFrames(straight, { spacingMm: 0 })).toEqual([]);
    expect(sampleCenterlineFrames(straight, { spacingMm: -1 })).toEqual([]);
    expect(sampleCenterlineFrames(straight, { spacingMm: NaN })).toEqual([]);
    expect(sampleCenterlineFrames([[0, 0, 0], [NaN, 0, 0]], { spacingMm: 10 })).toEqual([]);
  });

  it("曲がった経路でも接線が向きに追随する", () => {
    // x へ 50mm 進んでから y へ 50mm 曲がる L 字。
    const bent: Vec3[] = [
      [0, 0, 0],
      [25, 0, 0],
      [50, 0, 0],
      [50, 25, 0],
      [50, 50, 0],
    ];
    const f = sampleCenterlineFrames(bent, { spacingMm: 10, count: 9 });
    expect(f.length).toBeGreaterThan(4);
    const first = f[0].tangent;
    const last = f[f.length - 1].tangent;
    // 始めは +x 寄り、終わりは +y 寄り。
    expect(first[0]).toBeGreaterThan(Math.abs(first[1]));
    expect(last[1]).toBeGreaterThan(Math.abs(last[0]));
  });

  it("extractCenterline の枝をそのまま渡せる", () => {
    const m = emptyMask();
    fillBox(m, 5, 34, 19, 21, 19, 21);
    const graph = extractCenterline(m)!;
    const branch = graph.branches[0];
    const f = sampleCenterlineFrames(branch.pointsWorld, {
      spacingMm: 2,
      count: 5,
      anchorWorld: branch.pointsWorld[Math.floor(branch.pointsWorld.length / 2)],
    });
    expect(f.length).toBeGreaterThan(0);
    for (const fr of f) expect(norm(fr.tangent)).toBeCloseTo(1, 6);
  });
});
