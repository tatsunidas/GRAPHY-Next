/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI・マスクの「体積・面積・重心」を、**実装と独立な解析解**で確かめる（幾何検証・段 3）。
 *
 * 真値は患者座標（LPS, mm）の解析形状から手計算で出す（球 4/3πr³、直方体 abc、平行六面体 |det|）。
 * 画素・ボクセルの位置は DICOM の定義 P = IPP_k + i·Δ列·X + j·Δ行·Y（X, Y は IOP の行・列の向き）から
 * このファイルの `pixelWorld` で作り、実装の `voxelToWorld` などは使わない。
 *
 * 検証する幾何:
 *  G1 非正方画素（行 0.9 / 列 0.6 mm）・スライス 2.5 mm
 *  G2 二重斜位の IOP
 *  G3 ガントリーチルト 15°（IPP が面内の列方向へ d·tan15° ずつずれる。法線方向の間隔は d のまま）
 *  G4 不等間隔（2.0〜3.5 mm）と 1 枚欠損
 *  G5 IPP が位置の減る順
 *
 * 許容幅の考え方:
 *  - 箱（画素の境界に面を持つ直方体）の体積は離散化の誤差が無いので、浮動小数点の丸め（相対 1e-9）だけを許す。
 *  - 球の体積は、ボクセル中心の数え上げの誤差が「表面にかかるボクセルの層」に限られることから、
 *    |誤差| ≤ 表面積 × ボクセルの最大辺 / 2（`sphereBound`）。
 *  - 球の重心・線形場の平均は、中心をボクセル中心に置くと格子の点対称性から集合が中心に対して点対称になり、
 *    重心 = 中心が厳密に成り立つ（斜位・チルトでも格子は点対称）。許容は丸めだけ。
 */
import { describe, it, expect, vi } from "vitest";

const mock = vi.hoisted(() => ({
  images: new Map<string, unknown>(),
  meta: new Map<string, unknown>(),
  labelmapIds: [] as string[],
}));
vi.mock("@cornerstonejs/core", () => ({
  cache: { getImage: (id: string) => mock.images.get(id) },
  metaData: { get: (_t: string, id: string) => mock.meta.get(id) },
}));
vi.mock("@cornerstonejs/tools", () => ({
  segmentation: { getLabelmapImageIds: () => mock.labelmapIds },
}));

import { sliceGeometry, regularGrid, type SliceInfo } from "./sliceGeometry";
import { roiVolumeFromSlices } from "./roiVolumeMesh";
import {
  labelVolumeMeshVolume,
  maskVolumeFromGeometry,
  maskVolumeFromLabels,
  type MaskDepthContext,
} from "./depthVolume";
import {
  buildLabelVolumeFromSegmentation,
  countForeground,
  voxelToWorld,
  worldToVoxel,
  type VolumeGeom,
} from "./labelVolume";
import { rasterizeSphereToLabelVolume } from "./sphereRaster";
import { accumulateMaskStats } from "./maskStatsCore";
import { measureLabels } from "../plugins/pluginLabelStatsApi";
import { measureMask } from "../plugins/pluginMeshApi";
import type { PluginVolume } from "../plugins/pluginTypes";

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rel = (v: number, truth: number) => Math.abs(v - truth) / Math.abs(truth);
/** 3 本のベクトルの三重積の絶対値（平行六面体の体積）。 */
const det3 = (a: V3, b: V3, c: V3) => Math.abs(dot(a, cross(b, c)));

const COL = 0.6; // 列間隔（x。行方向 X に沿う）
const ROW = 0.9; // 行間隔（y。列方向 Y に沿う）
const AXIAL: [V3, V3] = [[1, 0, 0], [0, 1, 0]];
/** 二重斜位: R = Rx(20°)·Ry(25°) を軸に掛けた直交基底（行方向 X・列方向 Y）。 */
const OBLIQUE: [V3, V3] = (() => {
  const a = (20 * Math.PI) / 180, b = (25 * Math.PI) / 180;
  const Ry = (v: V3): V3 => [Math.cos(b) * v[0] + Math.sin(b) * v[2], v[1], -Math.sin(b) * v[0] + Math.cos(b) * v[2]];
  const Rx = (v: V3): V3 => [v[0], Math.cos(a) * v[1] - Math.sin(a) * v[2], Math.sin(a) * v[1] + Math.cos(a) * v[2]];
  return [Rx(Ry([1, 0, 0])), Rx(Ry([0, 1, 0]))];
})();

interface Stack {
  nCols: number;
  nRows: number;
  r: V3;
  c: V3;
  n: V3;
  /** ラベルマップの並び（z の順）の各スライスの IPP。 */
  ipps: V3[];
  /** ラベルマップの並びの各スライスの法線方向のオフセット（構成パラメータ。実装の出力ではない）。 */
  ds: number[];
}

/**
 * スタックを作る。`ds` は法線方向の位置（mm）。チルトは「d·tanθ だけ列方向へずらす」（法線方向の間隔は d のまま）。
 * `reversed` は ds の並びを逆にして IPP を位置の減る順にする。
 */
function makeStack(o: { nCols: number; nRows: number; ori: [V3, V3]; ds: number[]; tiltDeg?: number; reversed?: boolean; origin?: V3 }): Stack {
  const [r, c] = o.ori;
  const n = cross(r, c);
  const origin = o.origin ?? [-30, -20, 40];
  const t = Math.tan(((o.tiltDeg ?? 0) * Math.PI) / 180);
  const ds = o.reversed ? [...o.ds].reverse() : o.ds;
  const ipps = ds.map((d) => add(add(origin, mul(n, d)), mul(c, d * t)));
  return { nCols: o.nCols, nRows: o.nRows, r, c, n, ipps, ds };
}
const pixelWorld = (s: Stack, k: number, i: number, j: number): V3 =>
  add(add(s.ipps[k], mul(s.r, i * COL)), mul(s.c, j * ROW));
const infosOf = (s: Stack): SliceInfo[] =>
  s.ipps.map((p, k) => ({ id: `s${k}`, sop: `sop${k}`, ipp: p, iop: [...s.r, ...s.c] }));

/** 球（中心 LPS・半径 mm）の中に画素中心が入る画素を 1 にした、スライスごとのラベル。 */
function sphereLabels(s: Stack, center: V3, R: number): Uint8Array[] {
  return s.ipps.map((_, k) => {
    const lab = new Uint8Array(s.nCols * s.nRows);
    for (let j = 0; j < s.nRows; j++)
      for (let i = 0; i < s.nCols; i++) if (dist(pixelWorld(s, k, i, j), center) <= R) lab[j * s.nCols + i] = 1;
    return lab;
  });
}
/** 球の体積の離散化の上限: 表面積 × ボクセルの最大辺 / 2。 */
const sphereBound = (R: number, h: number) => (4 * Math.PI * R * R * h) / 2;
const sphereVol = (R: number) => (4 / 3) * Math.PI * R ** 3;

// ───────────────────────── 1. sliceGeometry ─────────────────────────
describe("sliceGeometry: 位置・幅（手計算）", () => {
  const uniform = Array.from({ length: 10 }, (_, k) => 2.5 * k);
  for (const [name, ori, tilt] of [
    ["G1 非正方・軸位", AXIAL, 0],
    ["G2 二重斜位", OBLIQUE, 0],
    ["G3 チルト 15°", AXIAL, 15],
  ] as const) {
    it(`${name}: 位置 = 構成した法線方向の位置、幅 = 2.5、均一`, () => {
      const s = makeStack({ nCols: 4, nRows: 4, ori, ds: uniform, tiltDeg: tilt });
      const g = sliceGeometry(infosOf(s));
      expect(g.kind).toBe("uniform");
      const base = dot(s.ipps[0], s.n);
      g.positions.forEach((p, i) => expect(p).toBeCloseTo(base + 2.5 * i, 9));
      g.widths.forEach((w) => expect(w).toBeCloseTo(2.5, 9));
      // acos は 1 の近傍で条件が悪く、丸め 1e-16 が 1e-8 rad（≈1e-6°）になる。許容は 1e-4°。
      expect(g.shearDeg).toBeCloseTo(tilt, 4);
    });
  }
  it("G3 負例: チルトの幅を「IPP 間の長さ」2.5/cos15° と読むと実装の値と一致しない（検査器が効く）", () => {
    const s = makeStack({ nCols: 4, nRows: 4, ori: AXIAL, ds: uniform, tiltDeg: 15 });
    const g = sliceGeometry(infosOf(s));
    expect(g.widths[3]).not.toBeCloseTo(2.5 / Math.cos((15 * Math.PI) / 180), 2);
  });
  it("G4 不等間隔: 幅 = 前後の距離の半分、端は最小間隔(2)の半分を外側に足す（手計算）", () => {
    // 間隔 2, 2.5, 3.5, 2, 2.5, 2, 3.5 → 幅 [2, 2.25, 3, 2.75, 2.25, 2.25, 2.75, 2.75]。合計 = 全長 18 + 最小間隔 2 = 20
    const s = makeStack({ nCols: 4, nRows: 4, ori: AXIAL, ds: [0, 2, 4.5, 8, 10, 12.5, 14.5, 18] });
    const g = sliceGeometry(infosOf(s));
    expect(g.kind).toBe("irregular");
    const want = [2, 2.25, 3, 2.75, 2.25, 2.25, 2.75, 2.75];
    want.forEach((w, i) => expect(g.widths[i]).toBeCloseTo(w, 9));
    expect(g.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(20, 9);
  });
  it("G4 欠損 1 枚（7.5 mm が無い）: kind=missing・欠け 1・幅 [2.5,2.5,3.75,3.75,2.5,2.5,2.5]、合計 = 8 枚 × 2.5 = 20", () => {
    const s = makeStack({ nCols: 4, nRows: 4, ori: AXIAL, ds: [0, 2.5, 5, 10, 12.5, 15, 17.5] });
    const g = sliceGeometry(infosOf(s));
    expect(g.kind).toBe("missing");
    expect(g.missingCount).toBe(1);
    [2.5, 2.5, 3.75, 3.75, 2.5, 2.5, 2.5].forEach((w, i) => expect(g.widths[i]).toBeCloseTo(w, 9));
    expect(g.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(20, 9);
    // 負例: 均一と見なした「枚数 × 公称間隔」は 7 × 2.5 = 17.5 で、20 と合わない。
    expect(g.order.length * 2.5).not.toBeCloseTo(20, 1);
  });
  it("G5 位置の減る順: order が逆順、位置は昇順、幅は位置の順に並ぶ", () => {
    const s = makeStack({ nCols: 4, nRows: 4, ori: OBLIQUE, ds: [0, 2, 4.5, 8, 10], reversed: true });
    const g = sliceGeometry(infosOf(s));
    expect(g.order).toEqual([4, 3, 2, 1, 0]);
    const base = dot(s.ipps[4], s.n);
    [0, 2, 4.5, 8, 10].forEach((d, i) => expect(g.positions[i]).toBeCloseTo(base + d, 9));
    // 端: (10-8)/2 + 最小間隔 2/2 = 2
    [2, 2.25, 3, 2.75, 2].forEach((w, i) => expect(g.widths[i]).toBeCloseTo(w, 9));
  });
});

// ───────────────────────── 2. 箱の体積（離散化誤差なし）─────────────────────────
interface BoxCase {
  name: string;
  ori: [V3, V3];
  ds: number[]; // 位置の昇順
  tiltDeg?: number;
  reversed?: boolean;
  /** 位置の順の添字で、ROI が含むスライスの範囲（両端を含む。端のスライスは含めない）。 */
  p0: number;
  p1: number;
  /** 一様な格子に載るか（labelVolumeMeshVolume の depth 経路も試す）。 */
  grid?: boolean;
}
const U10 = Array.from({ length: 10 }, (_, k) => 2.5 * k);
const boxCases: BoxCase[] = [
  { name: "G1 非正方・一様 2.5", ori: AXIAL, ds: U10, p0: 2, p1: 7, grid: true },
  { name: "G2 二重斜位", ori: OBLIQUE, ds: U10, p0: 2, p1: 7, grid: true },
  { name: "G3 チルト 15°", ori: AXIAL, ds: U10, tiltDeg: 15, p0: 2, p1: 7, grid: true },
  { name: "G4 不等間隔 2.0〜3.5", ori: AXIAL, ds: [0, 2, 4.5, 8, 10, 12.5, 14.5, 18, 20, 22.5, 26, 28], p0: 2, p1: 8 },
  { name: "G4 欠損 1 枚（ROI が欠損をまたぐ）", ori: AXIAL, ds: [0, 2.5, 5, 10, 12.5, 15, 17.5, 20, 22.5, 25], p0: 1, p1: 7, grid: true },
  { name: "G5 位置の減る順（一様）", ori: AXIAL, ds: U10, reversed: true, p0: 2, p1: 7, grid: true },
  { name: "G5 位置の減る順（不等間隔）", ori: AXIAL, ds: [0, 2, 4.5, 8, 10, 12.5, 14.5, 18, 20, 22.5, 26, 28], reversed: true, p0: 2, p1: 7 },
  { name: "G2+G3+G4+G5 全部入り（斜位・チルト・不等間隔・逆順）", ori: OBLIQUE, ds: [0, 2, 4.5, 8, 10, 12.5, 14.5, 18, 20, 22.5, 26, 28], tiltDeg: 15, reversed: true, p0: 2, p1: 7 },
];
const BOX = { i0: 5, i1: 24, j0: 3, j1: 16 }; // 画素の閉区間 → 20 × 14 画素 = 12.0 × 12.6 mm

function boxOf(bc: BoxCase) {
  const s = makeStack({ nCols: 30, nRows: 20, ori: bc.ori, ds: bc.ds, tiltDeg: bc.tiltDeg, reversed: bc.reversed });
  const n = bc.ds.length;
  const labelIdx = (p: number) => (bc.reversed ? n - 1 - p : p);
  const labels: Uint8Array[] = s.ipps.map(() => new Uint8Array(s.nCols * s.nRows));
  for (let p = bc.p0; p <= bc.p1; p++)
    for (let j = BOX.j0; j <= BOX.j1; j++) for (let i = BOX.i0; i <= BOX.i1; i++) labels[labelIdx(p)][j * s.nCols + i] = 1;
  // 真値: 面内 a×b（画素の境界）× 法線方向の高さ H。z の面は、含む端のスライスと外側の隣との中点。
  const a = (BOX.i1 - BOX.i0 + 1) * COL;
  const b = (BOX.j1 - BOX.j0 + 1) * ROW;
  const H = (bc.ds[bc.p1] + bc.ds[bc.p1 + 1]) / 2 - (bc.ds[bc.p0 - 1] + bc.ds[bc.p0]) / 2;
  return { s, labels, labelIdx, truth: a * b * H, a, b, H };
}

describe("箱の体積 = abc（roiVolumeFromSlices / maskVolumeFromGeometry / maskVolumeFromLabels）", () => {
  for (const bc of boxCases) {
    it(`${bc.name}: 3 経路とも解析解に一致`, () => {
      const { s, labels, truth } = boxOf(bc);
      const g = sliceGeometry(infosOf(s));
      const stackSlices = labels.map((l, k) => ({ stackIndex: k, labels: l, width: s.nCols, height: s.nRows }));
      const v1 = maskVolumeFromGeometry(stackSlices, g, COL, ROW).volumeMm3;
      expect(rel(v1, truth)).toBeLessThan(1e-9);

      const ctx: MaskDepthContext = {
        indexOfSource: new Map(s.ipps.map((_, k) => [`s${k}`, k])),
        geometry: g, colSp: COL, rowSp: ROW, spacingKnown: true,
      };
      const r2 = maskVolumeFromLabels(ctx, labels.map((l, k) => ({ sourceId: `s${k}`, labels: l, width: s.nCols, height: s.nRows })));
      expect(r2.warnings).toEqual([]);
      expect(rel(r2.volumeMm3!, truth)).toBeLessThan(1e-9);

      // roiVolumeFromSlices を、幅を直に渡して使う（位置の順に並べ替えた入力）。
      const r3 = roiVolumeFromSlices(
        g.order.map((k, p) => ({ labels: labels[k], width: s.nCols, height: s.nRows, colSpacingMm: COL, rowSpacingMm: ROW, widthMm: g.widths[p] })),
      );
      expect(rel(r3.volumeMm3, truth)).toBeLessThan(1e-9);
    });

    it(`${bc.name}: 負例（幅の取り方を壊すと外れる）`, () => {
      const { s, labels, truth, a, b } = boxOf(bc);
      const g = sliceGeometry(infosOf(s));
      const nFg = labels.filter((l) => l.some((v) => v)).length;
      // 壊し方 1: 全スライスを一様な間隔（公称間隔）と仮定する。不等間隔・欠損だけが外れる。
      const uni = roiVolumeFromSlices(
        labels.map((l) => ({ labels: l, width: s.nCols, height: s.nRows, colSpacingMm: COL, rowSpacingMm: ROW, widthMm: Math.abs(g.nominalSpacing) })),
      ).volumeMm3;
      if (g.kind === "uniform") expect(rel(uni, truth)).toBeLessThan(1e-9);
      else expect(rel(uni, truth)).toBeGreaterThan(1e-3);
      // 壊し方 2: IPP 間の長さ（チルトでは d/cos15°）を幅にする。チルトだけ外れる。
      const len = dist(s.ipps[1], s.ipps[0]);
      const tiltBad = a * b * nFg * len;
      if (bc.tiltDeg) expect(rel(tiltBad, truth)).toBeGreaterThan(1e-3);
      // 壊し方 3: 位置の順に直さず、入力の添字で幅を引く。逆順かつ不等間隔だけ外れる。
      const naive = roiVolumeFromSlices(
        labels.map((l, k) => ({ labels: l, width: s.nCols, height: s.nRows, colSpacingMm: COL, rowSpacingMm: ROW, widthMm: g.widths[k] })),
      ).volumeMm3;
      if (bc.reversed && g.kind !== "uniform") expect(rel(naive, truth)).toBeGreaterThan(1e-3);
      else expect(rel(naive, truth)).toBeLessThan(1e-9);
    });
  }

  it("G3 チルトの箱は平行六面体: 辺ベクトル (a·X, b·Y, N·step) の |det| = a·b·N·d（独立な式）", () => {
    const bc = boxCases[2];
    const { s, truth, a, b } = boxOf(bc);
    const step = add(s.ipps[1], mul(s.ipps[0], -1));
    const nSlices = bc.p1 - bc.p0 + 1;
    expect(rel(det3(mul(s.r, a), mul(s.c, b), mul(step, nSlices)), truth)).toBeLessThan(1e-9);
  });

  it("maskVolumeFromLabels: PixelSpacing 不明・スライス不明は体積を出さない（0 で埋めない）", () => {
    const { s, labels } = boxOf(boxCases[0]);
    const g = sliceGeometry(infosOf(s));
    const slices = labels.map((l, k) => ({ sourceId: `s${k}`, labels: l, width: s.nCols, height: s.nRows }));
    const base = { indexOfSource: new Map(s.ipps.map((_, k) => [`s${k}`, k])), geometry: g, colSp: 1, rowSp: 1 };
    expect(maskVolumeFromLabels({ ...base, spacingKnown: false }, slices).volumeMm3).toBeUndefined();
    expect(maskVolumeFromLabels({ ...base, indexOfSource: new Map(), spacingKnown: true }, slices).volumeMm3).toBeUndefined();
  });
});

describe("labelVolumeMeshVolume（3D labelmap の体積）", () => {
  for (const bc of boxCases.filter((c) => c.grid)) {
    it(`${bc.name}: depth（gridIndexOf と幅）を渡すと箱の体積に一致`, () => {
      const { s, labels, truth } = boxOf(bc);
      const g = sliceGeometry(infosOf(s));
      const grid = regularGrid(g);
      const sliceLen = s.nCols * s.nRows;
      const data = new Uint8Array(sliceLen * grid.count);
      g.order.forEach((k, p) => data.set(labels[k], grid.gridIndexOf[p] * sliceLen));
      const r = labelVolumeMeshVolume(data, [s.nCols, s.nRows, grid.count], [COL, ROW, grid.spacing], { gridIndexOf: grid.gridIndexOf, widths: g.widths });
      expect(rel(r.volumeMm3, truth)).toBeLessThan(1e-9);
    });
  }

  it("G4 欠損・負例: depth を渡さず全層を spacing[2] で数えると、欠けた層ぶん外れる", () => {
    const bc = boxCases[4];
    const { s, labels, truth } = boxOf(bc);
    const g = sliceGeometry(infosOf(s));
    const grid = regularGrid(g);
    const sliceLen = s.nCols * s.nRows;
    const data = new Uint8Array(sliceLen * grid.count);
    g.order.forEach((k, p) => data.set(labels[k], grid.gridIndexOf[p] * sliceLen));
    const r = labelVolumeMeshVolume(data, [s.nCols, s.nRows, grid.count], [COL, ROW, grid.spacing]);
    expect(rel(r.volumeMm3, truth)).toBeGreaterThan(1e-3);
  });
});

// ───────────────────────── 3. voxelToWorld / worldToVoxel / resolveGeom ─────────────────────────
/** スタックから、resolveGeom と同じ約束（z = 最初→最後の IPP の向き、間隔 = その長さ / (N-1)）の VolumeGeom を作る。 */
function geomLikeResolve(s: Stack): VolumeGeom {
  const last = s.ipps.length - 1;
  const v = add(s.ipps[last], mul(s.ipps[0], -1));
  const L = Math.hypot(v[0], v[1], v[2]);
  const z = mul(v, 1 / L);
  return {
    dims: [s.nCols, s.nRows, s.ipps.length],
    spacing: [COL, ROW, L / last],
    origin: [...s.ipps[0]],
    direction: [s.r[0], s.c[0], z[0], s.r[1], s.c[1], z[1], s.r[2], s.c[2], z[2]],
  };
}
const idxPoints: V3[] = [[0, 0, 0], [7, 3, 2], [12.5, 8.25, 4.5], [29, 19, 9]];

describe("voxelToWorld / worldToVoxel", () => {
  for (const [name, ori, tilt, reversed] of [
    ["G1 軸位", AXIAL, 0, false],
    ["G2 二重斜位", OBLIQUE, 0, false],
    ["G5 逆順", OBLIQUE, 0, true],
  ] as const) {
    it(`${name}: voxelToWorld は DICOM の定義 IPP_k + i·Δ列·X + j·Δ行·Y と一致`, () => {
      const s = makeStack({ nCols: 30, nRows: 20, ori, ds: U10, tiltDeg: tilt, reversed });
      const geom = geomLikeResolve(s);
      for (const [i, j, k] of [[0, 0, 0], [7, 3, 2], [29, 19, 9]]) {
        const w = voxelToWorld(geom, i, j, k);
        const t = pixelWorld(s, k, i, j);
        expect(dist(w, t)).toBeLessThan(1e-9);
      }
    });
    it(`${name}: worldToVoxel(voxelToWorld(index)) が元の index に戻る`, () => {
      const s = makeStack({ nCols: 30, nRows: 20, ori, ds: U10, tiltDeg: tilt, reversed });
      const geom = geomLikeResolve(s);
      for (const p of idxPoints) {
        const back = worldToVoxel(geom, voxelToWorld(geom, p[0], p[1], p[2]));
        expect(back[0]).toBeCloseTo(p[0], 6);
        expect(back[1]).toBeCloseTo(p[1], 6);
        expect(back[2]).toBeCloseTo(p[2], 6);
      }
    });
  }

  it("負例: 斜位でも、index の x と y を入れ替えた点は元に戻らない（往復の検査が効く）", () => {
    const s = makeStack({ nCols: 30, nRows: 20, ori: OBLIQUE, ds: U10 });
    const geom = geomLikeResolve(s);
    const back = worldToVoxel(geom, voxelToWorld(geom, 12.5, 8.25, 4.5));
    expect(back[0]).not.toBeCloseTo(8.25, 1);
  });
});

/** Cornerstone の cache / metaData を、スタックの幾何だけで最小に偽装して `buildLabelVolumeFromSegmentation` を通す（resolveGeom の検証用）。 */
function volumeViaResolveGeom(s: Stack, labels: Uint8Array[]) {
  mock.images.clear();
  mock.meta.clear();
  mock.labelmapIds = s.ipps.map((_, k) => `lm${k}`);
  s.ipps.forEach((p, k) => {
    const lab = labels[k];
    mock.images.set(`lm${k}`, { referencedImageId: `src${k}`, voxelManager: { getScalarData: () => lab, getAtIndex: (i: number) => lab[i] } });
    mock.meta.set(`src${k}`, {
      imagePositionPatient: p, rowCosines: s.r, columnCosines: s.c,
      rows: s.nRows, columns: s.nCols, rowPixelSpacing: ROW, columnPixelSpacing: COL,
    });
  });
  return buildLabelVolumeFromSegmentation("seg");
}

describe("resolveGeom（buildLabelVolumeFromSegmentation 経由。cornerstone の cache・metaData だけ偽装）", () => {
  for (const [name, ori, tilt, reversed] of [
    ["G1 軸位", AXIAL, 0, false],
    ["G2 二重斜位", OBLIQUE, 0, false],
    ["G5 逆順", OBLIQUE, 0, true],
  ] as const) {
    it(`${name}: 全スライスで voxelToWorld(0,0,k) = IPP_k`, () => {
      const s = makeStack({ nCols: 6, nRows: 5, ori, ds: U10, tiltDeg: tilt, reversed });
      const lv = volumeViaResolveGeom(s, s.ipps.map(() => new Uint8Array(30).fill(1)));
      expect(lv).not.toBeNull();
      s.ipps.forEach((p, k) => expect(dist(voxelToWorld(lv!.geom, 0, 0, k), p)).toBeLessThan(1e-9));
    });
  }
});

// ───────────────────────── 4. 球のラスタ化（sphereRaster）─────────────────────────
const SPH = { R: 12.03, nx: 60, ny: 40, nz: 16, ci: 30, cj: 18, ck: 8 };
const sphereCases: Array<[string, [V3, V3], number]> = [
  ["G1 非正方（行 0.9 / 列 0.6・スライス 2.5）", AXIAL, 0],
  ["G2 二重斜位", OBLIQUE, 0],
  ["G3 チルト 15°", AXIAL, 15],
  ["G3 チルト 15° + 二重斜位", OBLIQUE, 15],
];
const sphereCasesNoTilt = sphereCases.filter(([, , tilt]) => tilt === 0);
function sphereStack(ori: [V3, V3], tilt: number): Stack {
  return makeStack({ nCols: SPH.nx, nRows: SPH.ny, ori, ds: Array.from({ length: SPH.nz }, (_, k) => 2.5 * k), tiltDeg: tilt });
}
/** 独立な 1 ボクセルの体積: 辺ベクトル (Δ列·X, Δ行·Y, step) の |det|。 */
const cellVolume = (s: Stack) => det3(mul(s.r, COL), mul(s.c, ROW), add(s.ipps[1], mul(s.ipps[0], -1)));

describe("rasterizeSphereToLabelVolume（球 → ボクセル）", () => {
  for (const [name, ori, tilt] of sphereCasesNoTilt) {
    it(`${name}: 体積 ≈ 4/3πr³（上限は表面積 × 最大辺 / 2）、重心 = 中心、ボクセルの体積 = |det|`, () => {
      const s = sphereStack(ori, tilt);
      const center = pixelWorld(s, SPH.ck, SPH.ci, SPH.cj);
      const lv = rasterizeSphereToLabelVolume(geomLikeResolve(s), center, SPH.R);
      expect(lv).not.toBeNull();
      // 体積（数えた個数 × 真のボクセル体積）
      const vol = countForeground(lv!) * cellVolume(s);
      expect(Math.abs(vol - sphereVol(SPH.R))).toBeLessThan(sphereBound(SPH.R, 2.5));
      // 重心と、前景の分類（独立な距離判定と全ボクセルで一致）
      let sx = 0, sy = 0, sz = 0, n = 0, mism = 0, maxX = 0;
      for (let k = 0; k < SPH.nz; k++)
        for (let j = 0; j < SPH.ny; j++)
          for (let i = 0; i < SPH.nx; i++) {
            const w = pixelWorld(s, k, i, j);
            const dd = dist(w, center);
            if (Math.abs(dd - SPH.R) < 1e-9) continue; // ちょうど球面上の点は丸めで割れるので判定しない
            const inside = dd <= SPH.R;
            const fg = lv!.data[(k * SPH.ny + j) * SPH.nx + i] > 0;
            if (inside !== fg) mism++;
            if (fg) { sx += w[0]; sy += w[1]; sz += w[2]; n++; maxX = Math.max(maxX, Math.abs(dot(add(w, mul(center, -1)), s.r))); }
          }
      expect(mism).toBe(0);
      expect(dist([sx / n, sy / n, sz / n], center)).toBeLessThan(1e-9);
      // 行方向 X の広がりは r に近い（上限: 列間隔）
      expect(maxX).toBeGreaterThan(SPH.R - COL);
      expect(maxX).toBeLessThanOrEqual(SPH.R + 1e-9);
    });
  }

  for (const [name, ori, tilt] of sphereCasesNoTilt) {
    it(`${name}: lv.voxelMm3 = 辺ベクトルの |det|（Δ列·Δ行·法線方向の間隔）`, () => {
      const s = sphereStack(ori, tilt);
      const lv = rasterizeSphereToLabelVolume(geomLikeResolve(s), pixelWorld(s, SPH.ck, SPH.ci, SPH.cj), SPH.R);
      expect(lv!.voxelMm3).toBeCloseTo(cellVolume(s), 9);
    });
  }

  it("負例: 行・列の間隔を入れ替えた格子で作ると、独立な距離判定と食い違うボクセルが大量に出る（検査器が効く）", () => {
    const s = sphereStack(AXIAL, 0);
    const center = pixelWorld(s, SPH.ck, SPH.ci, SPH.cj);
    const bad = geomLikeResolve(s);
    bad.spacing = [ROW, COL, bad.spacing[2]];
    const lv = rasterizeSphereToLabelVolume(bad, center, SPH.R)!;
    let mism = 0;
    for (let k = 0; k < SPH.nz; k++) for (let j = 0; j < SPH.ny; j++) for (let i = 0; i < SPH.nx; i++) {
      const inside = dist(pixelWorld(s, k, i, j), center) <= SPH.R;
      if (inside !== lv.data[(k * SPH.ny + j) * SPH.nx + i] > 0) mism++;
    }
    expect(mism).toBeGreaterThan(100);
  });

  it("負例: 真値側を壊す（半径を 1.1 倍）と体積が上限を超える", () => {
    const s = sphereStack(AXIAL, 0);
    const lv = rasterizeSphereToLabelVolume(geomLikeResolve(s), pixelWorld(s, SPH.ck, SPH.ci, SPH.cj), SPH.R)!;
    const vol = countForeground(lv) * cellVolume(s);
    expect(Math.abs(vol - sphereVol(SPH.R * 1.1))).toBeGreaterThan(sphereBound(SPH.R, 2.5));
  });
});

// ───────────────────────── 5. プラグイン API（measureLabels / measureMask）─────────────────────────
/** index (i,j,k,1) → LPS の row-major 4×4。列 = (Δ列·X, Δ行·Y, step, IPP_0)。 */
function indexToWorldOf(s: Stack): number[] {
  const step = add(s.ipps[1], mul(s.ipps[0], -1));
  const cols = [mul(s.r, COL), mul(s.c, ROW), step, s.ipps[0]];
  return [0, 1, 2].flatMap((row) => cols.map((c) => c[row])).concat([0, 0, 0, 1]);
}
const FIELD = { A: 0.5, B: -0.8, C: 0.3, D: 20 }; // v = A·x + B·y + C·z + D（HU 相当）
const field = (p: V3) => FIELD.A * p[0] + FIELD.B * p[1] + FIELD.C * p[2] + FIELD.D;

function sphereVolumeData(s: Stack, center: V3, R: number, mapSwap = false) {
  const lab = sphereLabels(s, center, R);
  const plane = s.nCols * s.nRows;
  const labels = new Uint8Array(plane * lab.length);
  const vals = new Float32Array(plane * lab.length);
  lab.forEach((l, k) => {
    labels.set(l, k * plane);
    for (let j = 0; j < s.nRows; j++) for (let i = 0; i < s.nCols; i++) {
      const w = mapSwap ? add(add(s.ipps[k], mul(s.r, i * ROW)), mul(s.c, j * COL)) : pixelWorld(s, k, i, j);
      vals[k * plane + j * s.nCols + i] = field(w);
    }
  });
  return { labels, vals };
}
const asVolume = (s: Stack, vals: Float32Array, m: number[]): PluginVolume =>
  ({ data: vals, dims: [s.nCols, s.nRows, s.ipps.length], spacing: [COL, ROW, 2.5], indexToWorld: m, unit: "HU" }) as unknown as PluginVolume;

describe("measureLabels（H66）", () => {
  for (const [name, ori, tilt] of sphereCases) {
    it(`${name}: 体積・重心・線形場の平均・断面積`, () => {
      const s = sphereStack(ori, tilt);
      const center = pixelWorld(s, SPH.ck, SPH.ci, SPH.cj);
      const { labels, vals } = sphereVolumeData(s, center, SPH.R);
      const m = indexToWorldOf(s);
      const [r] = measureLabels({ data: labels, dims: [s.nCols, s.nRows, SPH.nz], indexToWorld: m }, asVolume(s, vals, m), { slices: [SPH.ck] });
      // 体積（真のボクセル体積 × 個数）
      expect(r.volumeMm3).toBeCloseTo(r.voxelCount * cellVolume(s), 6);
      expect(Math.abs(r.volumeMm3 - sphereVol(SPH.R))).toBeLessThan(sphereBound(SPH.R, 2.5));
      // 重心は中心（格子の点対称）
      expect(dist(r.centroidLps, center)).toBeLessThan(1e-6);
      // 線形場の平均 = 重心での場の値 = 中心での場の値（Float32 の丸めだけ許す）
      expect(Math.abs(r.stats!.mean - field(center))).toBeLessThan(1e-4);
      // 中心を通るスライスの断面積 ≈ πr²。上限は周長 × 最大の画素辺 / 2
      const area = r.slices[0].areaCm2 * 100;
      expect(Math.abs(area - Math.PI * SPH.R ** 2)).toBeLessThan((2 * Math.PI * SPH.R * ROW) / 2);
    });
  }
  it("負例: 行・列の列ベクトルを入れ替えた indexToWorld で測ると、重心が中心から外れる（検査器が効く）", () => {
    const s = sphereStack(OBLIQUE, 0);
    const center = pixelWorld(s, SPH.ck, SPH.ci, SPH.cj);
    const { labels, vals } = sphereVolumeData(s, center, SPH.R);
    const m = indexToWorldOf(s);
    const bad = [...m];
    for (let r = 0; r < 3; r++) { bad[4 * r] = m[4 * r + 1] * (COL / ROW); bad[4 * r + 1] = m[4 * r] * (ROW / COL); }
    const [r] = measureLabels({ data: labels, dims: [s.nCols, s.nRows, SPH.nz], indexToWorld: bad }, asVolume(s, vals, bad));
    expect(dist(r.centroidLps, center)).toBeGreaterThan(1);
  });
});

describe("measureMask（H33）", () => {
  for (const [name, ori, tilt] of sphereCases) {
    it(`${name}: meshVolumeMm3（平滑化なしの marching cubes）≈ 4/3πr³、境界ボックスの中心 = 中心`, () => {
      const s = sphereStack(ori, tilt);
      const center = pixelWorld(s, SPH.ck, SPH.ci, SPH.cj);
      const { labels } = sphereVolumeData(s, center, SPH.R);
      const [r] = measureMask({ data: labels, dims: [s.nCols, s.nRows, SPH.nz], indexToWorld: indexToWorldOf(s) }, { smoothIterations: 0 });
      // 平滑化なしの marching cubes のメッシュ体積
      expect(Math.abs(r.meshVolumeMm3 - sphereVol(SPH.R))).toBeLessThan(sphereBound(SPH.R, 2.5));
      // メッシュの境界ボックスの中心 = 球の中心（LPS）
      const mid = mul(add(r.boundsMin, r.boundsMax), 0.5);
      if (!tilt && ori === AXIAL) expect(dist(mid, center)).toBeLessThan(1e-6);
    });
  }
  for (const [name, ori, tilt] of sphereCasesNoTilt) {
    it(`${name}: voxelVolumeMm3 = ボクセル数 × 真のボクセル体積（辺ベクトルの |det|）で ≈ 4/3πr³`, () => {
      const s = sphereStack(ori, tilt);
      const center = pixelWorld(s, SPH.ck, SPH.ci, SPH.cj);
      const { labels } = sphereVolumeData(s, center, SPH.R);
      const [r] = measureMask({ data: labels, dims: [s.nCols, s.nRows, SPH.nz], indexToWorld: indexToWorldOf(s) }, { smoothIterations: 0 });
      expect(r.voxelVolumeMm3).toBeCloseTo(r.voxelCount * cellVolume(s), 6);
      expect(Math.abs(r.voxelVolumeMm3 - sphereVol(SPH.R))).toBeLessThan(sphereBound(SPH.R, 2.5));
    });
  }
  it("負例: 真値側を壊す（中心を 3 mm ずらす）と境界ボックスの中心が合わなくなる", () => {
    const s = sphereStack(AXIAL, 0);
    const center = pixelWorld(s, SPH.ck, SPH.ci, SPH.cj);
    const { labels } = sphereVolumeData(s, center, SPH.R);
    const [r] = measureMask({ data: labels, dims: [s.nCols, s.nRows, SPH.nz], indexToWorld: indexToWorldOf(s) }, { smoothIterations: 0 });
    const mid = mul(add(r.boundsMin, r.boundsMax), 0.5);
    expect(dist(mid, add(center, [3, 0, 0]))).toBeGreaterThan(1);
  });
});

// ───────────────────────── 6. maskStatsCore（線形場の平均）─────────────────────────
describe("accumulateMaskStats: 線形場 v = A·x + B·y + C·z + D の平均 = 重心での場の値", () => {
  for (const [name, ori, tilt] of sphereCases) {
    it(`${name}: 球の中心がボクセル中心のとき、平均 = 中心での場の値（画素の拾い方に依らない）、個数 = 球内の画素数`, () => {
      const s = sphereStack(ori, tilt);
      const center = pixelWorld(s, SPH.ck, SPH.ci, SPH.cj);
      const lab = sphereLabels(s, center, SPH.R);
      const slices = lab.map((l, k) => ({
        labels: l,
        values: Float64Array.from({ length: l.length }, (_, p) => field(pixelWorld(s, k, p % s.nCols, Math.floor(p / s.nCols)))),
      }));
      const r = accumulateMaskStats(slices);
      expect(r.voxels).toBe(lab.reduce((a, l) => a + l.reduce((x, v) => x + v, 0), 0));
      expect(Math.abs(r.mean! - field(center))).toBeLessThan(1e-9);
      // 最大・最小は、球の表面（中心から ±R）にある場の値の範囲に収まる: |v - f(c)| ≤ |∇f|·R
      const gradLen = Math.hypot(FIELD.A, FIELD.B, FIELD.C);
      expect(r.max! - field(center)).toBeLessThanOrEqual(gradLen * SPH.R + 1e-9);
      expect(field(center) - r.min!).toBeLessThanOrEqual(gradLen * SPH.R + 1e-9);
    });
  }
  it("負例: 画素 → mm の写像を壊した場（行・列の間隔を入れ替え）で作ると平均が中心の値から外れる", () => {
    const s = sphereStack(OBLIQUE, 0);
    const center = pixelWorld(s, SPH.ck, SPH.ci, SPH.cj);
    const lab = sphereLabels(s, center, SPH.R);
    const slices = lab.map((l, k) => ({
      labels: l,
      values: Float64Array.from({ length: l.length }, (_, p) =>
        field(add(add(s.ipps[k], mul(s.r, (p % s.nCols) * ROW)), mul(s.c, Math.floor(p / s.nCols) * COL)))),
    }));
    expect(Math.abs(accumulateMaskStats(slices).mean! - field(center))).toBeGreaterThan(1e-3);
  });
});
