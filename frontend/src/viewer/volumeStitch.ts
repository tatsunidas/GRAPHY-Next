/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 患者 LPS mm の格子への引き直しと、同じ座標系の部分ボリュームの結合
 * （設計: `fw/volume-regrid-design.md`「結合」）。
 *
 * <p>`regGeometry.ts` と同じく**純関数のみ**。DOM も cornerstone も import しない。
 */

import { sampleTrilinear, type RegVolume } from "./regGeometry";

export interface StitchPetInfo {
  decayCorrection?: string;
  referenceTimeMs?: number;
  units?: string;
  halfLifeSec?: number;
  totalDoseBq?: number;
}

export interface StitchInput {
  volume: RegVolume;
  /** DICOM の IOP（行方向 3, 列方向 3 の順で DICOM の並びそのまま）。 */
  iop: number[];
  modality: string;
  patientId: string;
  pet?: StitchPetInfo;
}

export type StitchViolation =
  | "patient"
  | "orientation"
  | "modality"
  | "petReference"
  | "tooFew";

export interface StitchCheck {
  ok: boolean;
  violations: StitchViolation[];
}

/**
 * 向きの許容角 [rad]。ボリュームの端が向きのずれで動く量（面内の最長寸法 L × 角）が、面内の最小間隔 s の半分に
 * 収まる角 s / (2L)。視野が大きいほど・間隔が細かいほど厳しくなる（500 mm・1 mm で 1e-3 rad）。
 */
function orientToleranceRad(inputs: readonly StitchInput[]): number {
  let longest = 0;
  let finest = Infinity;
  for (const x of inputs) {
    const [nx, ny] = x.volume.dims;
    const [sx, sy] = x.volume.spacing;
    longest = Math.max(longest, Math.hypot((nx - 1) * sx, (ny - 1) * sy));
    finest = Math.min(finest, sx, sy);
  }
  return longest > 0 ? finest / (2 * longest) : 0;
}

/** 2 本の単位ベクトルのなす角 [rad]。1 に近い内積から acos で求めると精度が落ちるので外積を使う。 */
function angleBetween(a: readonly number[], b: readonly number[]): number {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), dot3(a, b));
}

function unit(a: number, b: number, c: number): [number, number, number] {
  const n = Math.hypot(a, b, c) || 1;
  return [a / n, b / n, c / n];
}

function dot3(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function petComplete(p: StitchPetInfo | undefined): p is Required<StitchPetInfo> {
  if (!p) return false;
  const finite = (v: number | undefined) => typeof v === "number" && Number.isFinite(v);
  return (
    !!p.decayCorrection && !!p.units &&
    finite(p.referenceTimeMs) && finite(p.halfLifeSec) && finite(p.totalDoseBq)
  );
}

/** 結合できる入力の組かを判定する。違反した条件をすべて返す（黙って通さない）。 */
export function checkStitchInputs(inputs: readonly StitchInput[]): StitchCheck {
  const v = new Set<StitchViolation>();
  if (inputs.length < 2) v.add("tooFew");
  if (inputs.length > 0) {
    const f = inputs[0];
    if (inputs.some((x) => x.patientId !== f.patientId)) v.add("patient");
    if (inputs.some((x) => x.modality !== f.modality)) v.add("modality");

    const r0 = unit(f.iop[0], f.iop[1], f.iop[2]);
    const c0 = unit(f.iop[3], f.iop[4], f.iop[5]);
    const tol = orientToleranceRad(inputs);
    for (const x of inputs) {
      if (x.iop.length < 6 || x.iop.slice(0, 6).some((t) => !Number.isFinite(t))) {
        v.add("orientation");
        continue;
      }
      const r = unit(x.iop[0], x.iop[1], x.iop[2]);
      const c = unit(x.iop[3], x.iop[4], x.iop[5]);
      if (!(angleBetween(r0, r) <= tol && angleBetween(c0, c) <= tol)) v.add("orientation");
    }

    const isPet = (m: string) => m === "PT" || m === "NM";
    if (inputs.some((x) => isPet(x.modality))) {
      if (!inputs.every((x) => petComplete(x.pet))) {
        v.add("petReference");
      } else {
        const p0 = f.pet as Required<StitchPetInfo>;
        const same = inputs.every((x) => {
          const p = x.pet as Required<StitchPetInfo>;
          return (
            p.decayCorrection === p0.decayCorrection &&
            p.referenceTimeMs === p0.referenceTimeMs &&
            p.units === p0.units &&
            p.halfLifeSec === p0.halfLifeSec &&
            p.totalDoseBq === p0.totalDoseBq
          );
        });
        if (!same) v.add("petReference");
      }
    }
  }
  const order: StitchViolation[] = [
    "tooFew", "patient", "orientation", "modality", "petReference",
  ];
  const violations = order.filter((k) => v.has(k));
  return { ok: violations.length === 0, violations };
}

export interface StitchGrid {
  dims: [number, number, number];
  /** 列方向・行方向・スライス方向の間隔 [mm]。 */
  spacing: [number, number, number];
  indexToWorld: Float64Array;
  worldToIndex: Float64Array;
  /** 入力ごとの法線方向の区間 [w0, w1]（ボクセル中心、mm）。入力と同じ順。 */
  intervals: Array<[number, number]>;
  /** 2 本以上が覆う法線方向の長さ [mm]。各入力はボクセルの縁（中心 ± 間隔/2）で測る。 */
  overlapMm: number;
  /** 和集合の範囲内でどの入力も覆わない法線方向の長さ [mm]（縁で測る）。ぴったり隣り合う 2 本は 0。 */
  gapMm: number;
  /** 出力のボクセル数 = dims の積。 */
  voxelCount: number;
  /** 出力のボクセル数 ÷ 全入力のボクセル数の和。間隔の違う入力が混ざって格子が膨らむと大きくなる。上限は呼び出し側が決める。 */
  inflation: number;
}

/** 入力の 8 隅のボクセル中心を (rc, rr, n) へ射影した各軸の [min, max]。 */
function projectedRanges(
  vol: RegVolume,
  rc: readonly number[],
  rr: readonly number[],
  n: readonly number[],
): Array<[number, number]> {
  const [nx, ny, nz] = vol.dims;
  const m = vol.indexToWorld;
  const axes = [rc, rr, n];
  const out: Array<[number, number]> = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (const k of [0, nz - 1]) {
    for (const j of [0, ny - 1]) {
      for (const i of [0, nx - 1]) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3];
        const y = m[4] * i + m[5] * j + m[6] * k + m[7];
        const z = m[8] * i + m[9] * j + m[10] * k + m[11];
        for (let a = 0; a < 3; a++) {
          const p = axes[a][0] * x + axes[a][1] * y + axes[a][2] * z;
          if (p < out[a][0]) out[a][0] = p;
          if (p > out[a][1]) out[a][1] = p;
        }
      }
    }
  }
  return out;
}

/** 区間の集合から、2 本以上が覆う長さと、和集合の範囲内の覆われない長さを求める。 */
function coverage(intervals: ReadonlyArray<[number, number]>): { overlap: number; gap: number } {
  const pts = new Set<number>();
  for (const [a, b] of intervals) { pts.add(a); pts.add(b); }
  const xs = [...pts].sort((p, q) => p - q);
  let overlap = 0;
  let gap = 0;
  for (let t = 0; t + 1 < xs.length; t++) {
    const mid = (xs[t] + xs[t + 1]) / 2;
    const len = xs[t + 1] - xs[t];
    let cnt = 0;
    for (const [a, b] of intervals) if (a <= mid && mid <= b) cnt++;
    if (cnt >= 2) overlap += len;
    else if (cnt === 0) gap += len;
  }
  return { overlap, gap };
}

/**
 * 全入力を覆う和集合の格子を作る。
 *
 * @param spacingOverride [列, 行, スライス] の間隔 [mm]。省略時は軸ごとの入力の最小値。
 */
export function unionGrid(
  inputs: readonly StitchInput[],
  spacingOverride?: readonly [number, number, number],
): StitchGrid {
  if (inputs.length === 0) throw new Error("volumeStitch: 入力が無い");
  const iop = inputs[0].iop;
  const rc = unit(iop[0], iop[1], iop[2]);
  const rr = unit(iop[3], iop[4], iop[5]);
  const n: [number, number, number] = [
    rc[1] * rr[2] - rc[2] * rr[1],
    rc[2] * rr[0] - rc[0] * rr[2],
    rc[0] * rr[1] - rc[1] * rr[0],
  ];

  const ranges = inputs.map((x) => projectedRanges(x.volume, rc, rr, n));
  const intervals = ranges.map((r) => [r[2][0], r[2][1]] as [number, number]);

  const spacing: [number, number, number] = spacingOverride
    ? [spacingOverride[0], spacingOverride[1], spacingOverride[2]]
    : [
        Math.min(...inputs.map((x) => x.volume.spacing[0])),
        Math.min(...inputs.map((x) => x.volume.spacing[1])),
        Math.min(...inputs.map((x) => x.volume.spacing[2])),
      ];
  if (spacing.some((s) => !(s > 0) || !Number.isFinite(s))) {
    throw new Error("volumeStitch: 間隔が正の有限値でない");
  }

  // 法線方向で最も手前（w が最小）の入力を基準にする。
  let front = 0;
  for (let t = 1; t < inputs.length; t++) if (intervals[t][0] < intervals[front][0]) front = t;

  const dims: [number, number, number] = [0, 0, 0];
  const org: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const lo = Math.min(...ranges.map((r) => r[a][0]));
    const hi = Math.max(...ranges.map((r) => r[a][1]));
    const ref = ranges[front][a][0];
    const s = spacing[a];
    const shift = a === 2 ? 0 : Math.ceil((ref - lo) / s - 1e-9);
    org[a] = ref - shift * s;
    dims[a] = Math.floor((hi - org[a]) / s + 1e-9) + 1;
  }

  const o: [number, number, number] = [
    org[0] * rc[0] + org[1] * rr[0] + org[2] * n[0],
    org[0] * rc[1] + org[1] * rr[1] + org[2] * n[1],
    org[0] * rc[2] + org[1] * rr[2] + org[2] * n[2],
  ];
  const axes = [rc, rr, n];
  const indexToWorld = new Float64Array(16);
  const worldToIndex = new Float64Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      indexToWorld[r * 4 + c] = axes[c][r] * spacing[c];
      worldToIndex[r * 4 + c] = axes[r][c] / spacing[r];
    }
    indexToWorld[r * 4 + 3] = o[r];
    worldToIndex[r * 4 + 3] = -(axes[r][0] * o[0] + axes[r][1] * o[1] + axes[r][2] * o[2]) / spacing[r];
  }
  indexToWorld[15] = 1;
  worldToIndex[15] = 1;

  const edges = intervals.map(([a, b], t) => {
    const h = inputs[t].volume.spacing[2] / 2;
    return [a - h, b + h] as [number, number];
  });
  const { overlap, gap } = coverage(edges);
  const voxelCount = dims[0] * dims[1] * dims[2];
  const inputVoxels = inputs.reduce((sum, x) => sum + x.volume.dims[0] * x.volume.dims[1] * x.volume.dims[2], 0);
  return {
    dims, spacing, indexToWorld, worldToIndex, intervals,
    overlapMm: overlap, gapMm: gap, voxelCount, inflation: voxelCount / inputVoxels,
  };
}

/** 浮動小数の丸め分（index で 1e-6）。中心の範囲の端の点を NaN にしないための許容。 */
const ROUNDING_INDEX = 1e-6;
/** ボクセルは中心から ±半ボクセルを占める。 */
const HALF_VOXEL_INDEX = 0.5;

/**
 * index を端の中心から `tol` 以内なら端へ寄せる。それより外は範囲外の index のまま返す
 * （`sampleTrilinear` が範囲外を NaN にする）。
 */
function clampIndex(v: number, max: number, tol: number): number {
  if (v < 0) return v >= -tol ? 0 : v;
  if (v > max) return v <= max + tol ? max : v;
  return v;
}

function sampleInput(vol: RegVolume, x: number, y: number, z: number, tol: number): number {
  const m = vol.worldToIndex;
  const [nx, ny, nz] = vol.dims;
  const i = clampIndex(m[0] * x + m[1] * y + m[2] * z + m[3], nx - 1, tol);
  const j = clampIndex(m[4] * x + m[5] * y + m[6] * z + m[7], ny - 1, tol);
  const k = clampIndex(m[8] * x + m[9] * y + m[10] * z + m[11], nz - 1, tol);
  return sampleTrilinear(vol, i, j, k);
}

function meanAt(inputs: readonly StitchInput[], x: number, y: number, z: number, tol: number): number {
  let sum = 0;
  let cnt = 0;
  for (const inp of inputs) {
    const s = sampleInput(inp.volume, x, y, z, tol);
    if (!Number.isNaN(s)) { sum += s; cnt++; }
  }
  return cnt > 0 ? sum / cnt : NaN;
}

/**
 * 格子の各点を各入力から引き、覆っている入力の算術平均をスライスごとに 1 枚ずつ返す。
 * どの入力も覆わない点は NaN（0 では空気と区別できない）。全スライスを一度に持たずに符号化へ渡せる。
 */
export function* stitchSlices(
  inputs: readonly StitchInput[],
  grid: StitchGrid,
  overlap: "mean",
): Generator<Float32Array, void, undefined> {
  if (overlap !== "mean") throw new Error(`volumeStitch: 未対応の重なりの扱い ${overlap}`);
  const [nx, ny, nz] = grid.dims;
  const m = grid.indexToWorld;
  for (let k = 0; k < nz; k++) {
    const out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3];
        const y = m[4] * i + m[5] * j + m[6] * k + m[7];
        const z = m[8] * i + m[9] * j + m[10] * k + m[11];
        // 中心の範囲に入る入力だけで平均する。どれも覆わない点に限り、ボクセルの縁（半ボクセル）まで
        // 端の値で受ける。重なりの中で端の複製を平均に混ぜると、傾きのある値で継ぎ目に偏りが出る。
        let value = meanAt(inputs, x, y, z, ROUNDING_INDEX);
        if (Number.isNaN(value)) value = meanAt(inputs, x, y, z, HALF_VOXEL_INDEX);
        out[j * nx + i] = value;
      }
    }
    yield out;
  }
}

/** `stitchSlices` の全スライスを配列にして返す（小さい入力・テスト向け）。 */
export function stitchToGrid(
  inputs: readonly StitchInput[],
  grid: StitchGrid,
  overlap: "mean",
): Float32Array[] {
  return [...stitchSlices(inputs, grid, overlap)];
}

/** IOP から求めた法線（行方向 × 列方向）。`unionGrid` が使う軸と同じ。 */
export function normalOfIop(iop: readonly number[]): [number, number, number] {
  const rc = unit(iop[0], iop[1], iop[2]);
  const rr = unit(iop[3], iop[4], iop[5]);
  return [
    rc[1] * rr[2] - rc[2] * rr[1],
    rc[2] * rr[0] - rc[0] * rr[2],
    rc[0] * rr[1] - rc[1] * rr[0],
  ];
}

/** 入力の法線方向の縁（ボクセル中心 ± スライス間隔/2）。 */
function normalEdges(input: StitchInput, n: readonly number[]): [number, number] {
  const iop = input.iop;
  const [, , r] = projectedRanges(input.volume, unit(iop[0], iop[1], iop[2]), unit(iop[3], iop[4], iop[5]), n);
  const h = input.volume.spacing[2] / 2;
  return [r[0] - h, r[1] + h];
}

/**
 * 全入力の法線方向の位置がほぼ同じ（= 座標が位置関係を表していない）か。
 * 装置がステーションごとに座標を原点に戻して書き出すと、IPP が全部同じになる。
 * 区間の端のずれが全入力の最小スライス間隔の半分以内なら「同じ」とみなす。
 */
export function coordinatesCoincide(inputs: readonly StitchInput[]): boolean {
  if (inputs.length < 2) return false;
  const n = normalOfIop(inputs[0].iop);
  const edges = inputs.map((x) => normalEdges(x, n));
  const tol = Math.min(...inputs.map((x) => x.volume.spacing[2])) / 2;
  return edges.every((e) => Math.abs(e[0] - edges[0][0]) <= tol && Math.abs(e[1] - edges[0][1]) <= tol);
}

/**
 * 入力を並べた順に、隣り合う 2 本の重なりが `overlapMm`（負なら隙間）になる法線方向のずらし量 [mm] を返す。
 * 1 本目は動かさない。`reverse` なら法線の − 方向へ並べる。結果は `inputs` と同じ順。
 */
export function placeAlongNormal(
  inputs: readonly StitchInput[],
  overlapMm: number,
  reverse: boolean,
): number[] {
  if (inputs.length === 0) return [];
  const n = normalOfIop(inputs[0].iop);
  const shifts: number[] = [0];
  let [lo, hi] = normalEdges(inputs[0], n);
  for (let t = 1; t < inputs.length; t++) {
    const [a, b] = normalEdges(inputs[t], n);
    const d = reverse ? lo + overlapMm - b : hi - overlapMm - a;
    shifts.push(d);
    lo = a + d;
    hi = b + d;
  }
  return shifts;
}

/** 法線方向に `d` mm 平行移動した入力（データは共有。元は変えない）。 */
export function shiftInput(input: StitchInput, d: number, n: readonly number[]): StitchInput {
  if (d === 0) return input;
  const v = input.volume;
  const i2w = Float64Array.from(v.indexToWorld);
  const w2i = Float64Array.from(v.worldToIndex);
  for (let r = 0; r < 3; r++) {
    i2w[r * 4 + 3] += d * n[r];
    w2i[r * 4 + 3] -= d * (w2i[r * 4] * n[0] + w2i[r * 4 + 1] * n[1] + w2i[r * 4 + 2] * n[2]);
  }
  return { ...input, volume: { ...v, indexToWorld: i2w, worldToIndex: w2i } };
}

/**
 * プレビュー用の間隔。最長の辺が `maxPx` 画素に収まるよう、軸ごとに「出力の間隔」と「最長の辺 / maxPx」の大きい方を採る
 * （出力より細かくはしない）。
 */
export function previewSpacing(grid: Pick<StitchGrid, "dims" | "spacing">, maxPx: number): [number, number, number] {
  const ext = grid.dims.map((d, a) => d * grid.spacing[a]);
  const iso = Math.max(...ext) / Math.max(1, maxPx);
  return [0, 1, 2].map((a) => Math.max(grid.spacing[a], iso)) as [number, number, number];
}

export interface MipImages {
  dims: [number, number, number];
  /** 軸位断（k 方向の最大）。幅 nx・高さ ny。`ax[j·nx + i]`。 */
  ax: Float32Array;
  /** 冠状断（j 方向の最大）。幅 nx・高さ nz。`cor[k·nx + i]`。 */
  cor: Float32Array;
  /** 矢状断（i 方向の最大）。幅 ny・高さ nz。`sag[k·ny + j]`。 */
  sag: Float32Array;
}

/** `stitchSlices` のスライスを 1 枚ずつ受けて 3 方向の MIP を集計する（全体を保持しない）。NaN は無視。 */
export class MipAccumulator {
  private readonly ax: Float32Array;
  private readonly cor: Float32Array;
  private readonly sag: Float32Array;
  constructor(private readonly dims: [number, number, number]) {
    const [nx, ny, nz] = dims;
    this.ax = new Float32Array(nx * ny).fill(-Infinity);
    this.cor = new Float32Array(nx * nz).fill(-Infinity);
    this.sag = new Float32Array(ny * nz).fill(-Infinity);
  }
  add(k: number, slice: Float32Array): void {
    const [nx, ny] = this.dims;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = slice[j * nx + i];
        if (Number.isNaN(v)) continue;
        if (v > this.ax[j * nx + i]) this.ax[j * nx + i] = v;
        if (v > this.cor[k * nx + i]) this.cor[k * nx + i] = v;
        if (v > this.sag[k * ny + j]) this.sag[k * ny + j] = v;
      }
    }
  }
  /** どの入力も覆わなかった画素は NaN。 */
  result(): MipImages {
    const fix = (a: Float32Array) => a.map((v) => (v === -Infinity ? NaN : v));
    return { dims: this.dims, ax: fix(this.ax), cor: fix(this.cor), sag: fix(this.sag) };
  }
}
