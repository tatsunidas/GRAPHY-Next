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

/**
 * 結合の判定に要る値だけ（画素を読み込まなくても、レイアウトのメタデータから作れる）。
 * `inplaneLongestMm` は面内の最長寸法、`inplaneFinestMm` は面内の最小間隔（向きの許容角 s / (2L) の入力）。
 */
export interface StitchBasis {
  iop: number[];
  modality: string;
  patientId: string;
  pet?: StitchPetInfo;
  inplaneLongestMm: number;
  inplaneFinestMm: number;
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
function orientToleranceRad(inputs: readonly StitchBasis[]): number {
  let longest = 0;
  let finest = Infinity;
  for (const x of inputs) {
    longest = Math.max(longest, x.inplaneLongestMm);
    finest = Math.min(finest, x.inplaneFinestMm);
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
export function checkStitchInputs(
  inputs: readonly StitchInput[],
  opts: { orientation?: "strict" | "resample" } = {},
): StitchCheck {
  return checkStitchBasis(inputs.map(basisOf), opts);
}

function basisOf(x: StitchInput): StitchBasis {
  const [nx, ny] = x.volume.dims;
  const [sx, sy] = x.volume.spacing;
  return {
    iop: x.iop, modality: x.modality, patientId: x.patientId, pet: x.pet,
    inplaneLongestMm: Math.hypot((nx - 1) * sx, (ny - 1) * sy),
    inplaneFinestMm: Math.min(sx, sy),
  };
}

/** {@link checkStitchInputs} の本体。ボリュームを持たない呼び出し（レイアウトだけの連結）も同じ判定を使う。 */
export function checkStitchBasis(
  inputs: readonly StitchBasis[],
  opts: { orientation?: "strict" | "resample" } = {},
): StitchCheck {
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
      // 向きの違いを許す指定では、基準の軸への再サンプルに任せる（IOP が有限であることだけ見る）。
      if (opts.orientation === "resample") continue;
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
  ref = 0,
): StitchGrid {
  if (inputs.length === 0) throw new Error("volumeStitch: 入力が無い");
  const iop = inputs[ref].iop;
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
    const r0 = ranges[front][a][0];
    const s = spacing[a];
    const shift = a === 2 ? 0 : Math.ceil((r0 - lo) / s - 1e-9);
    org[a] = r0 - shift * s;
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

/**
 * 重なりの扱い。
 * - mean: 覆っている入力の算術平均（従来）。
 * - linear: 各入力の法線方向の縁からの距離で重みを付ける（羽毛化）。縁に近い入力は弱く、内側の入力は強い。
 *   `fraction`（0 < f ≤ 1）は重みが切り替わる範囲で、1 なら重なり全体で線形、小さいほど中央で急に切り替わる。
 * - midpoint: 重なりの中点で切り、法線方向の縁から最も遠い（＝内側の）入力の値だけを採る（混ぜない）。
 *   2D の連結（`virtualLayout.concatLayouts`）と同じ規則。同じ距離なら入力の順が早い方。
 * - gains: 入力ごとの倍率（信号の拡大率の違いを合わせる）。サンプルに掛ける。
 */
export interface BlendOptions {
  mode: "mean" | "linear" | "midpoint";
  fraction?: number;
  gains?: readonly number[];
}

export const BLEND_MEAN: BlendOptions = { mode: "mean" };

/**
 * 点 (x,y,z) を覆う入力から値を作る。覆う入力が無ければ NaN。
 * `lo`/`hi` は入力ごとの法線方向の縁（ボクセル中心 ± 間隔/2）、`n` は法線。
 */
function blendAt(
  inputs: readonly StitchInput[],
  edges: ReadonlyArray<readonly [number, number]>,
  n: readonly number[],
  blend: BlendOptions,
  x: number, y: number, z: number, tol: number,
): number {
  const s: number[] = [];
  const d: number[] = [];
  const w = n[0] * x + n[1] * y + n[2] * z;
  for (let t = 0; t < inputs.length; t++) {
    const v = sampleInput(inputs[t].volume, x, y, z, tol);
    if (Number.isNaN(v)) continue;
    s.push(blend.gains ? v * blend.gains[t] : v);
    d.push(Math.max(0, Math.min(w - edges[t][0], edges[t][1] - w)));
  }
  const cnt = s.length;
  if (cnt === 0) return NaN;
  if (cnt === 1) return s[0];
  if (blend.mode === "midpoint") {
    let best = 0;
    for (let t = 1; t < cnt; t++) if (d[t] > d[best]) best = t;
    return s[best];
  }
  let wsum = 0;
  let vsum = 0;
  if (blend.mode === "linear") {
    const f = blend.fraction ?? 1;
    const dsum = d.reduce((a, b) => a + b, 0);
    for (let t = 0; t < cnt; t++) {
      const others = (dsum - d[t]) / (cnt - 1);
      const tot = d[t] + others;
      const q = tot > 0 ? (d[t] - others) / tot : 0;
      const wt = Math.min(1, Math.max(0, 0.5 + q / (2 * f)));
      wsum += wt;
      vsum += wt * s[t];
    }
  }
  if (wsum <= 0) return s.reduce((a, b) => a + b, 0) / cnt;
  return vsum / wsum;
}

/**
 * 格子の各点を各入力から引き、重なりを `blend` に従って混ぜたものをスライスごとに 1 枚ずつ返す。
 * どの入力も覆わない点は NaN（0 では空気と区別できない）。全スライスを一度に持たずに符号化へ渡せる。
 */
export function* stitchSlices(
  inputs: readonly StitchInput[],
  grid: StitchGrid,
  blend: BlendOptions,
): Generator<Float32Array, void, undefined> {
  if (blend.mode !== "mean" && blend.mode !== "linear" && blend.mode !== "midpoint") throw new Error(`volumeStitch: 未対応の重なりの扱い ${String(blend.mode)}`);
  const f = blend.fraction ?? 1;
  if (blend.mode === "linear" && !(f > 0 && f <= 1)) throw new Error("volumeStitch: ブレンドの範囲は 0 より大きく 1 以下");
  if (blend.gains && blend.gains.length !== inputs.length) throw new Error("volumeStitch: gains の数が入力と合わない");
  const [nx, ny, nz] = grid.dims;
  const m = grid.indexToWorld;
  // 法線は格子から取る（基準シリーズの向き）。
  const gn = unit(m[2], m[6], m[10]);
  const n: [number, number, number] = [gn[0], gn[1], gn[2]];
  const edges = inputs.map((x) => normalEdges(x, n));
  for (let k = 0; k < nz; k++) {
    const out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3];
        const y = m[4] * i + m[5] * j + m[6] * k + m[7];
        const z = m[8] * i + m[9] * j + m[10] * k + m[11];
        // 中心の範囲に入る入力だけで混ぜる。どれも覆わない点に限り、ボクセルの縁（半ボクセル）まで
        // 端の値で受ける。重なりの中で端の複製を混ぜると、傾きのある値で継ぎ目に偏りが出る。
        let value = blendAt(inputs, edges, n, blend, x, y, z, ROUNDING_INDEX);
        if (Number.isNaN(value)) value = blendAt(inputs, edges, n, blend, x, y, z, HALF_VOXEL_INDEX);
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
  blend: BlendOptions,
): Float32Array[] {
  return [...stitchSlices(inputs, grid, blend)];
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
 * `overlapMm` が数なら全部の組で同じ値、配列なら組ごと（長さ `inputs.length - 1`、t 番目が t → t+1 番目の組）。
 * 1 本目は動かさない。`reverse` なら法線の − 方向へ並べる。結果は `inputs` と同じ順。
 */
export function placeAlongNormal(
  inputs: readonly StitchInput[],
  overlapMm: number | readonly number[],
  reverse: boolean,
  ref = 0,
): number[] {
  if (inputs.length === 0) return [];
  if (typeof overlapMm !== "number" && overlapMm.length !== inputs.length - 1) {
    throw new Error(`overlapMm の数 ${overlapMm.length} が組の数 ${inputs.length - 1} と合わない`);
  }
  const n = normalOfIop(inputs[ref].iop);
  const shifts: number[] = [0];
  let [lo, hi] = normalEdges(inputs[0], n);
  for (let t = 1; t < inputs.length; t++) {
    const [a, b] = normalEdges(inputs[t], n);
    const ov = typeof overlapMm === "number" ? overlapMm : overlapMm[t - 1];
    const d = reverse ? lo + ov - b : hi - ov - a;
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

export interface GainEstimate {
  /** 入力と同じ順の倍率。基準（法線方向の最も手前）の入力は 1。推定できない入力は前の入力の倍率のまま。 */
  gains: number[];
  /** 入力ごとに、手前の入力との重なりから倍率を推定できたか（基準は true）。 */
  estimable: boolean[];
}

/**
 * ステーション間の信号の拡大率（ゲイン）の違いを、重なり領域の比で推定する。
 * 法線方向の位置順に並べ、隣り合う 2 本の重なりで両方から引いた値の和の比 gain_next = gain_prev · Σa / Σb を連鎖させる
 * （大きい信号に自然に重みが乗り、雑音床の影響が小さい）。重なりが無い・和が正でない組は推定不可（倍率は 1 倍のまま連鎖）。
 */
export function estimateGains(inputs: readonly StitchInput[]): GainEstimate {
  const gains = inputs.map(() => 1);
  const estimable = inputs.map(() => false);
  if (inputs.length === 0) return { gains, estimable };
  const n = normalOfIop(inputs[0].iop);
  const edges = inputs.map((x) => normalEdges(x, n));
  const order = inputs.map((_, t) => t).sort((a, b) => edges[a][0] - edges[b][0]);
  estimable[order[0]] = true;
  const grid = unionGrid(inputs);
  const [nx, ny, nz] = grid.dims;
  // 面内は約 64 画素に間引く（和の比には十分。表示サイズと同じ考え方）。
  const stride = Math.max(1, Math.floor(Math.min(nx, ny) / 64));
  const m = grid.indexToWorld;
  for (let q = 1; q < order.length; q++) {
    const a = order[q - 1];
    const b = order[q];
    const lo = Math.max(edges[a][0], edges[b][0]);
    const hi = Math.min(edges[a][1], edges[b][1]);
    gains[b] = gains[a];
    if (!(hi > lo)) continue;
    let sa = 0;
    let sb = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j += stride) {
        for (let i = 0; i < nx; i += stride) {
          const x = m[0] * i + m[1] * j + m[2] * k + m[3];
          const y = m[4] * i + m[5] * j + m[6] * k + m[7];
          const z = m[8] * i + m[9] * j + m[10] * k + m[11];
          const w = n[0] * x + n[1] * y + n[2] * z;
          if (w < lo || w > hi) continue;
          const va = sampleInput(inputs[a].volume, x, y, z, ROUNDING_INDEX);
          const vb = sampleInput(inputs[b].volume, x, y, z, ROUNDING_INDEX);
          if (Number.isNaN(va) || Number.isNaN(vb)) continue;
          sa += va;
          sb += vb;
        }
      }
    }
    if (sa > 0 && sb > 0) {
      gains[b] = gains[a] * (sa / sb);
      estimable[b] = true;
    }
  }
  return { gains, estimable };
}

export interface EndMatchPair {
  /** `order` の中での位置（from → to が隣り合う）。 */
  from: number;
  to: number;
  /** 端の一致度（重なり部分のピアソン相関の最大値）。 */
  score: number;
  /** その相関が最大になった重なり [mm]。 */
  overlapMm: number;
}

export interface EndMatch {
  /** 面内の格子・間隔が揃わず比較できなかったとき false（order は入力の並びのまま）。 */
  comparable: boolean;
  /** 入力の添字を、法線方向の + 向きに並べた順。 */
  order: number[];
  /** 隣り合う組ごとの一致度と重なり。 */
  pairs: EndMatchPair[];
  /** 最良の順序と次点の順序の、一致度の総和の差（大きいほど確からしい）。入力が 2 本未満なら null。 */
  margin: number | null;
}

/** 面内を `b` 画素ずつのブロック平均で縮めた各スライス（法線方向に昇順）。 */
function endSlices(input: StitchInput, n: readonly number[], b: number): Float32Array[] {
  const [nx, ny, nz] = input.volume.dims;
  const m = input.volume.indexToWorld;
  const ascending = m[2] * n[0] + m[6] * n[1] + m[10] * n[2] > 0;
  const rx = Math.floor(nx / b);
  const ry = Math.floor(ny / b);
  const out: Float32Array[] = [];
  for (let s = 0; s < nz; s++) {
    const k = ascending ? s : nz - 1 - s;
    const img = new Float32Array(rx * ry);
    for (let j = 0; j < ry; j++) {
      for (let i = 0; i < rx; i++) {
        let sum = 0;
        for (let dj = 0; dj < b; dj++) {
          for (let di = 0; di < b; di++) sum += input.volume.data[k * nx * ny + (j * b + dj) * nx + (i * b + di)];
        }
        img[j * rx + i] = sum / (b * b);
      }
    }
    out.push(img);
  }
  return out;
}

/** A の末尾 m 枚と B の先頭 m 枚（同じ解剖として対応）のピアソン相関を m = 2..上限で求め、最大の m を返す。 */
function bestEndOverlap(a: Float32Array[], b: Float32Array[]): { score: number; slices: number } {
  const na = a.length;
  const mMax = Math.min(na, b.length) - 1;
  let best = { score: -Infinity, slices: 0 };
  for (let mm = 2; mm <= mMax; mm++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, cnt = 0;
    for (let i = 0; i < mm; i++) {
      const pa = a[na - mm + i];
      const pb = b[i];
      for (let p = 0; p < pa.length; p++) {
        const x = pa[p];
        const y = pb[p];
        sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
      }
      cnt += pa.length;
    }
    const va = saa - (sa * sa) / cnt;
    const vb = sbb - (sb * sb) / cnt;
    if (!(va > 0 && vb > 0)) continue; // 一定の値（相関が定義できない）
    const rho = (sab - (sa * sb) / cnt) / Math.sqrt(va * vb);
    if (rho > best.score) best = { score: rho, slices: mm };
  }
  return best;
}

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = () => {
    if (cur.length === n) { out.push([...cur]); return; }
    for (let t = 0; t < n; t++) {
      if (used[t]) continue;
      used[t] = true; cur.push(t); rec(); cur.pop(); used[t] = false;
    }
  };
  rec();
  return out;
}

/** 全順列を試す入力数の上限（8! = 40320）。これを超えたら貪欲法。 */
const EXHAUSTIVE_MAX = 8;

/**
 * 読み込んだ入力の並び順を、ボリュームの端同士の一致度で決める。
 * 各入力のスライスを法線方向に昇順に並べ、「A の末尾 m 枚」と「B の先頭 m 枚」の相関を全 m で求めて、
 * 隣り合う一致度の総和が最大の順序を選ぶ（相関なのでゲイン・オフセットの違いに依らない）。
 * 面内の格子（列数・行数・間隔・面内の位置）やスライス間隔が揃わない入力があるときは比較しない。
 */
export function matchEnds(inputs: readonly StitchInput[]): EndMatch {
  const idle = inputs.map((_, t) => t);
  const none: EndMatch = { comparable: false, order: idle, pairs: [], margin: null };
  if (inputs.length < 2) return { ...none, comparable: inputs.length === 1 };
  const f = inputs[0];
  const n = normalOfIop(f.iop);
  const rc = unit(f.iop[0], f.iop[1], f.iop[2]);
  const rr = unit(f.iop[3], f.iop[4], f.iop[5]);
  const inPlane = (x: StitchInput) => {
    const m = x.volume.indexToWorld;
    const p = [m[3], m[7], m[11]];
    return [dot3(rc, p), dot3(rr, p)];
  };
  const o0 = inPlane(f);
  for (const x of inputs) {
    const [nx, ny] = x.volume.dims;
    const [sx, sy, sz] = x.volume.spacing;
    const same = (u: number, v: number) => Math.abs(u - v) <= 1e-3 * Math.max(Math.abs(u), Math.abs(v), 1e-9);
    const o = inPlane(x);
    if (
      nx !== f.volume.dims[0] || ny !== f.volume.dims[1] ||
      !same(sx, f.volume.spacing[0]) || !same(sy, f.volume.spacing[1]) || !same(sz, f.volume.spacing[2]) ||
      Math.abs(o[0] - o0[0]) > sx / 2 || Math.abs(o[1] - o0[1]) > sy / 2
    ) return none;
  }
  const b = Math.max(1, Math.floor(Math.min(f.volume.dims[0], f.volume.dims[1]) / 64));
  const sl = inputs.map((x) => endSlices(x, n, b));
  const N = inputs.length;
  const score: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(-Infinity));
  const slices: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (let p = 0; p < N; p++) {
    for (let q = 0; q < N; q++) {
      if (p === q) continue;
      const r = bestEndOverlap(sl[p], sl[q]);
      score[p][q] = r.score;
      slices[p][q] = r.slices;
    }
  }
  const total = (perm: number[]) => {
    let s = 0;
    for (let t = 0; t + 1 < perm.length; t++) s += score[perm[t]][perm[t + 1]];
    return s;
  };
  let order: number[];
  let margin: number | null = null;
  if (N <= EXHAUSTIVE_MAX) {
    const scored = permutations(N).map((perm) => ({ perm, s: total(perm) })).sort((u, v) => v.s - u.s);
    order = scored[0].perm;
    margin = scored.length > 1 ? scored[0].s - scored[1].s : null;
  } else {
    // 貪欲: 最も一致する組から鎖を伸ばす。
    let bp = 0, bq = 1;
    for (let p = 0; p < N; p++) for (let q = 0; q < N; q++) if (p !== q && score[p][q] > score[bp][bq]) { bp = p; bq = q; }
    order = [bp, bq];
    const left = new Set(idle.filter((t) => t !== bp && t !== bq));
    while (left.size > 0) {
      let bt = -1, bs = -Infinity, atEnd = true;
      for (const t of left) {
        const e = score[order[order.length - 1]][t];
        const h = score[t][order[0]];
        if (e > bs) { bs = e; bt = t; atEnd = true; }
        if (h > bs) { bs = h; bt = t; atEnd = false; }
      }
      if (atEnd) order.push(bt); else order.unshift(bt);
      left.delete(bt);
    }
  }
  const dz = f.volume.spacing[2];
  const pairs: EndMatchPair[] = [];
  for (let t = 0; t + 1 < order.length; t++) {
    pairs.push({
      from: order[t], to: order[t + 1],
      score: score[order[t]][order[t + 1]],
      overlapMm: slices[order[t]][order[t + 1]] * dz,
    });
  }
  return { comparable: true, order, pairs, margin };
}
