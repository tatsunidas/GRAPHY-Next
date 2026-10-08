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
  frameOfReferenceUid: string;
  modality: string;
  patientId: string;
  pet?: StitchPetInfo;
}

export type StitchViolation =
  | "patient"
  | "frameOfReference"
  | "orientation"
  | "modality"
  | "petReference"
  | "tooFew";

export interface StitchCheck {
  ok: boolean;
  violations: StitchViolation[];
}

const ORIENT_DOT_MIN = 1 - 1e-6;

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
    if (!f.frameOfReferenceUid || inputs.some((x) => x.frameOfReferenceUid !== f.frameOfReferenceUid)) {
      v.add("frameOfReference");
    }
    if (inputs.some((x) => x.modality !== f.modality)) v.add("modality");

    const r0 = unit(f.iop[0], f.iop[1], f.iop[2]);
    const c0 = unit(f.iop[3], f.iop[4], f.iop[5]);
    for (const x of inputs) {
      if (x.iop.length < 6 || x.iop.slice(0, 6).some((t) => !Number.isFinite(t))) {
        v.add("orientation");
        continue;
      }
      const r = unit(x.iop[0], x.iop[1], x.iop[2]);
      const c = unit(x.iop[3], x.iop[4], x.iop[5]);
      if (dot3(r0, r) < ORIENT_DOT_MIN || dot3(c0, c) < ORIENT_DOT_MIN) v.add("orientation");
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
    "tooFew", "patient", "frameOfReference", "orientation", "modality", "petReference",
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
  overlapMm: number;
  gapMm: number;
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
  if (inputs.length === 0) throw new Error("gridResample: 入力が無い");
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
    throw new Error("gridResample: 間隔が正の有限値でない");
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

  const { overlap, gap } = coverage(intervals);
  return { dims, spacing, indexToWorld, worldToIndex, intervals, overlapMm: overlap, gapMm: gap };
}

/** index の境界を浮動小数の丸め分（1e-6）だけ許して端へ寄せる。範囲外は NaN のまま。 */
function snap(v: number, max: number): number {
  const EPS = 1e-6;
  if (v < 0) return v >= -EPS ? 0 : v;
  if (v > max) return v <= max + EPS ? max : v;
  return v;
}

function sampleInput(vol: RegVolume, x: number, y: number, z: number): number {
  const m = vol.worldToIndex;
  const [nx, ny, nz] = vol.dims;
  const i = snap(m[0] * x + m[1] * y + m[2] * z + m[3], nx - 1);
  const j = snap(m[4] * x + m[5] * y + m[6] * z + m[7], ny - 1);
  const k = snap(m[8] * x + m[9] * y + m[10] * z + m[11], nz - 1);
  return sampleTrilinear(vol, i, j, k);
}

/**
 * 格子の各点を各入力から引き、覆っている入力の算術平均を返す（スライスごと）。
 * どの入力も覆わない点は NaN（0 では空気と区別できない）。
 */
export function stitchToGrid(
  inputs: readonly StitchInput[],
  grid: StitchGrid,
  overlap: "mean",
): Float32Array[] {
  if (overlap !== "mean") throw new Error(`gridResample: 未対応の重なりの扱い ${overlap}`);
  const [nx, ny, nz] = grid.dims;
  const m = grid.indexToWorld;
  const slices: Float32Array[] = [];
  for (let k = 0; k < nz; k++) {
    const out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3];
        const y = m[4] * i + m[5] * j + m[6] * k + m[7];
        const z = m[8] * i + m[9] * j + m[10] * k + m[11];
        let sum = 0;
        let cnt = 0;
        for (const inp of inputs) {
          const s = sampleInput(inp.volume, x, y, z);
          if (!Number.isNaN(s)) { sum += s; cnt++; }
        }
        out[j * nx + i] = cnt > 0 ? sum / cnt : NaN;
      }
    }
    slices.push(out);
  }
  return slices;
}
