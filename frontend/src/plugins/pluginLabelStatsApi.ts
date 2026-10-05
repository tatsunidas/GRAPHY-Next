/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **H66 — ラベルの volume を測る**（`fw/ct-quant-design.md` §3）。
 *
 * AI のセグメンテーション（1 ボクセル 1 ラベル）と H10 の校正済みボリュームから、ラベルごとの
 * 体積・値の統計と、指定したスライスでの面積を返す。H33（`measureMask`）はメッシュ化するので
 * 100 を超えるラベルには重く、値の統計も持たない。計測をプラグインに書かせない理由は H5・H33 と同じ。
 *
 * <h3>量の定義</h3>
 *
 * - 体積はボクセルの数え上げ（H33 の `voxelVolumeMm3` と同じ）。1 ボクセルの体積は `indexToWorld` の
 *   3 列の三重積の絶対値（スライスが斜めに進む格子でも正しい）。
 * - スライスの面積は画素の数え上げ × 画素面積（1・2 列の外積の大きさ）。ROI 統計の「メッシュの面積」
 *   （`fw/roi-stats-design.md`）とは別の量。体組成の文献の面積はこちらで定義されている。
 * - 値は H10 の校正済みの値をそのまま読む（単位は `values.unit`。二重に校正しない）。
 */
import { summarizeValues, type RoiValueStats } from "../viewer/roiStats";
import type { PluginVolume } from "./pluginTypes";

/** 測るラベルの volume（`loadVolume` と同じ z-major の並び）。0 は背景。 */
export interface PluginLabelInput {
  data: Uint8Array | Uint16Array;
  dims: [number, number, number];
  indexToWorld: number[];
}

export interface PluginLabelStatsOptions {
  /** 測るラベル。省略時は出てくる全部。 */
  labels?: number[];
  /** 1 にすると、境界の 1 ボクセル（6 近傍のどれかが別ラベル・格子の外）を除いた統計も返す。 */
  erodeVoxels?: 0 | 1;
  /** 面積を出すスライス（格子の k）。 */
  slices?: number[];
  /** スライス内で、値がこの範囲（両端を含む）に入る画素の面積も出す。 */
  valueRanges?: Array<{ name: string; min: number; max: number }>;
}

/**
 * 値の統計は ROI 統計と同じ実装（`summarizeValues`）を通す。標準偏差は母標準偏差、非有限値は除く。
 * 有限の値が 1 つも無ければ null。
 */
export type PluginValueStats = RoiValueStats;

export interface PluginLabelSliceMeasurement {
  k: number;
  pixelCount: number;
  areaCm2: number;
  /** 前景が無ければ NaN。 */
  mean: number;
  /** `valueRanges` の名前 → 面積（cm²）。 */
  rangeAreasCm2: Record<string, number>;
}

export interface PluginLabelMeasurement {
  label: number;
  voxelCount: number;
  volumeMm3: number;
  volumeMl: number;
  /** 値の単位（`values.unit` のまま）。 */
  unit: string;
  stats: PluginValueStats | null;
  /** `erodeVoxels: 1` のときだけ。境界を除くと何も残らなければ null。 */
  eroded?: PluginValueStats | null;
  /** 前景のあるスライスの範囲 [最小 k, 最大 k]。 */
  kRange: [number, number];
  /** ボクセル中心の重心（患者 LPS mm）。 */
  centroidLps: [number, number, number];
  slices: PluginLabelSliceMeasurement[];
}

/** 格子の一致を見る許容差（間隔に対する比）。 */
const GRID_TOLERANCE = 1e-3;

function column(m: number[], c: number): [number, number, number] {
  return [m[c], m[4 + c], m[8 + c]];
}

function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sameGrid(labels: PluginLabelInput, values: PluginVolume): string | null {
  const [a, b] = [labels.dims, values.dims];
  if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return `dims differ: ${a.join("x")} vs ${b.join("x")}`;
  const tol = GRID_TOLERANCE * Math.min(...values.spacing.map((s) => Math.abs(s) || Infinity));
  for (let i = 0; i < 12; i++) {
    if (Math.abs(labels.indexToWorld[i] - values.indexToWorld[i]) > tol) {
      return `indexToWorld differs at ${i}: ${labels.indexToWorld[i]} vs ${values.indexToWorld[i]}`;
    }
  }
  return null;
}

/**
 * ラベルの volume を測る（H66）。
 *
 * @throws 格子（dims・indexToWorld）が `values` と一致しないとき（ずれたまま測らない）
 * @returns ラベル番号の昇順。前景の無いラベルは返さない。
 */
export function measureLabels(
  labels: PluginLabelInput,
  values: PluginVolume,
  opts: PluginLabelStatsOptions = {},
): PluginLabelMeasurement[] {
  const [nx, ny, nz] = labels.dims;
  const total = nx * ny * nz;
  if (labels.data.length !== total) throw new Error(`labels.data length ${labels.data.length} != ${total}`);
  if (values.data.length !== total) throw new Error(`values.data length ${values.data.length} != ${total}`);
  const mismatch = sameGrid(labels, values);
  if (mismatch) throw new Error(`measureLabels: label grid does not match the volume (${mismatch})`);

  const m = labels.indexToWorld;
  const c0 = column(m, 0);
  const c1 = column(m, 1);
  const c2 = column(m, 2);
  const n01 = cross(c0, c1);
  const voxelMm3 = Math.abs(n01[0] * c2[0] + n01[1] * c2[1] + n01[2] * c2[2]);
  const pixelMm2 = Math.hypot(n01[0], n01[1], n01[2]);

  const counts = new Map<number, number>();
  for (let i = 0; i < total; i++) {
    const v = labels.data[i];
    if (v !== 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const wanted = (opts.labels && opts.labels.length > 0 ? opts.labels : [...counts.keys()])
    .filter((l) => l !== 0 && (counts.get(l) ?? 0) > 0)
    .sort((a, b) => a - b);
  const slices = (opts.slices ?? []).filter((k) => Number.isInteger(k) && k >= 0 && k < nz);
  const ranges = opts.valueRanges ?? [];
  const lab = labels.data;
  const val = values.data;
  const plane = nx * ny;

  const out: PluginLabelMeasurement[] = [];
  for (const label of wanted) {
    const n = counts.get(label) ?? 0;
    const all = new Float32Array(n);
    const inner = opts.erodeVoxels === 1 ? new Float32Array(n) : null;
    let a = 0;
    let e = 0;
    let kMin = Infinity;
    let kMax = -Infinity;
    let si = 0;
    let sj = 0;
    let sk = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * j + plane * k;
          if (lab[idx] !== label) continue;
          all[a++] = val[idx];
          si += i;
          sj += j;
          sk += k;
          if (k < kMin) kMin = k;
          if (k > kMax) kMax = k;
          if (inner) {
            const interior =
              i > 0 && i < nx - 1 && j > 0 && j < ny - 1 && k > 0 && k < nz - 1 &&
              lab[idx - 1] === label && lab[idx + 1] === label &&
              lab[idx - nx] === label && lab[idx + nx] === label &&
              lab[idx - plane] === label && lab[idx + plane] === label;
            if (interior) inner[e++] = val[idx];
          }
        }
      }
    }
    const ci = si / n;
    const cj = sj / n;
    const ck = sk / n;
    const centroidLps: [number, number, number] = [
      m[0] * ci + m[1] * cj + m[2] * ck + m[3],
      m[4] * ci + m[5] * cj + m[6] * ck + m[7],
      m[8] * ci + m[9] * cj + m[10] * ck + m[11],
    ];

    const sliceOut: PluginLabelSliceMeasurement[] = slices.map((k) => {
      let count = 0;
      let sum = 0;
      const rangeCounts = ranges.map(() => 0);
      const base = plane * k;
      for (let p = 0; p < plane; p++) {
        if (lab[base + p] !== label) continue;
        const v = val[base + p];
        count++;
        sum += v;
        for (let r = 0; r < ranges.length; r++) {
          if (v >= ranges[r].min && v <= ranges[r].max) rangeCounts[r]++;
        }
      }
      const rangeAreasCm2: Record<string, number> = {};
      ranges.forEach((r, idx) => (rangeAreasCm2[r.name] = (rangeCounts[idx] * pixelMm2) / 100));
      return { k, pixelCount: count, areaCm2: (count * pixelMm2) / 100, mean: count > 0 ? sum / count : NaN, rangeAreasCm2 };
    });

    out.push({
      label,
      voxelCount: n,
      volumeMm3: n * voxelMm3,
      volumeMl: (n * voxelMm3) / 1000,
      unit: values.unit,
      stats: summarizeValues(all.subarray(0, a), values.unit),
      ...(inner ? { eroded: summarizeValues(inner.subarray(0, e), values.unit) } : {}),
      kRange: [kMin, kMax],
      centroidLps,
      slices: sliceOut,
    });
  }
  return out;
}
