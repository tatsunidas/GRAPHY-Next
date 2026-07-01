/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ヒストグラム解析（GRAPHY 2D Viewer > Process > Histogram の Next 移植）。
 *
 * <p>単一スライスまたは（同一 C/T の）Z スタック全体について、利用者指定の
 * ビン幅／ビン数でヒストグラムと一次統計量（平均・分散・歪度・尖度・エントロピー等）
 * を計算する。値は Cornerstone のキャッシュ画像から取り出し、Modality LUT
 * （Rescale Slope/Intercept, 例: CT の HU）が付いていれば校正値で評価する
 * ——3D LUT ヒストグラム・Curved MPR と同じ方針。オリジナルの
 * {@code com.vis.core.histogram.HistogramAnalyzer} に対応。
 */
import { readModalitySlice, type ModalitySlice } from "./pixelCalibration";

/** ビンの決め方: 固定ビン幅、またはデータ範囲を等分する固定ビン数。 */
export type BinMode = "width" | "count";
export interface BinSpec {
  mode: BinMode;
  /** mode==="width" のときビン幅（校正値の単位）、"count" のときビン数。 */
  value: number;
}

/**
 * 校正済みの 1 スライス。輝度の二重適用防止のため、読み取りは
 * {@link ./pixelCalibration} に一元化している（{@link ModalitySlice} のエイリアス）。
 */
export type Slice = ModalitySlice;

/** ヒストグラム解析の結果（ビンごとの度数＋一次統計量）。 */
export interface HistogramData {
  binStart: number; // ビン 0 の左端の値
  binWidth: number;
  binCount: number;
  counts: number[]; // length === binCount
  totalCount: number;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  variance: number;
  mode: number; // 最頻ビンの中心値
  median: number; // 累積度数からの線形補間
  skewness: number;
  kurtosis: number; // 過剰尖度（正規分布 === 0）
  entropy: number; // シャノンエントロピー（底 2, 非空ビン）
  valueUnit: string; // 例 "HU"、未校正は "raw"
}

export function binLow(d: HistogramData, index: number): number {
  return d.binStart + index * d.binWidth;
}
export function binHigh(d: HistogramData, index: number): number {
  return d.binStart + (index + 1) * d.binWidth;
}

/**
 * imageId のピクセルを校正済み float スライスとして読み出す。未ロードなら読み込む。
 * 実体は {@link ./pixelCalibration} の {@link readModalitySlice}（輝度の二重適用を防ぐ唯一の入口）。
 */
export const loadSlice = readModalitySlice;

/** 単一スライスのヒストグラム。 */
export function analyzeSlice(slice: Slice, spec: BinSpec): HistogramData {
  return analyze([slice], spec);
}

/**
 * スライス群のヒストグラム＋一次統計量。全スライスは同じ単位である前提
 * （先頭スライスの unit を採用）。オリジナルの HistogramAnalyzer.analyze と同ロジック。
 */
export function analyze(slices: Slice[], spec: BinSpec): HistogramData {
  const unit = slices.length ? slices[0].unit : "raw";

  // Pass 1: min/max/mean。
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let count = 0;
  for (const s of slices) {
    const v = s.values;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (x < min) min = x;
      if (x > max) max = x;
      sum += x;
      count++;
    }
  }
  if (count === 0) throw new Error("No pixels to analyze");
  const mean = sum / count;
  const range = Math.max(max - min, 1e-9);

  let binWidth: number;
  let binCount: number;
  if (spec.mode === "width") {
    binWidth = Math.max(spec.value, 1e-9);
    binCount = Math.max(1, Math.ceil(range / binWidth));
  } else {
    binCount = Math.max(1, Math.round(spec.value));
    binWidth = range / binCount;
  }
  // 巨大なビン数は描画・メモリともに無意味なので上限を設ける。
  binCount = Math.min(binCount, 65536);
  const binStart = min;
  const counts = new Array<number>(binCount).fill(0);

  // Pass 2: 中心モーメント（分散/歪度/尖度）とビン度数。
  let sumSq = 0;
  let sumCube = 0;
  let sumQuad = 0;
  for (const s of slices) {
    const v = s.values;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      const d = x - mean;
      const d2 = d * d;
      sumSq += d2;
      sumCube += d2 * d;
      sumQuad += d2 * d2;

      let bin = Math.floor((x - binStart) / binWidth);
      if (bin < 0) bin = 0;
      if (bin >= binCount) bin = binCount - 1;
      counts[bin]++;
    }
  }

  const variance = sumSq / count;
  const stdDev = Math.sqrt(variance);
  const skewness = stdDev > 0 ? sumCube / count / Math.pow(stdDev, 3) : 0;
  const kurtosis = stdDev > 0 ? sumQuad / count / Math.pow(stdDev, 4) - 3.0 : 0; // 過剰尖度

  let modeBin = 0;
  let modeCount = -1;
  for (let i = 0; i < binCount; i++) {
    if (counts[i] > modeCount) {
      modeCount = counts[i];
      modeBin = i;
    }
  }
  const mode = binStart + (modeBin + 0.5) * binWidth;

  const median = estimateMedian(counts, binStart, binWidth, count);
  const entropy = shannonEntropy(counts, count);

  return {
    binStart,
    binWidth,
    binCount,
    counts,
    totalCount: count,
    min,
    max,
    mean,
    stdDev,
    variance,
    mode,
    median,
    skewness,
    kurtosis,
    entropy,
    valueUnit: unit,
  };
}

/**
 * このスライスで校正値が [lo, hi) に入るピクセルを立てた boolean マスク
 * （row-major, width*height）。選択ビンの強調表示に使う。
 */
export function computeBinMask(slice: Slice, lo: number, hi: number): Uint8Array {
  const v = slice.values;
  const mask = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    mask[i] = v[i] >= lo && v[i] < hi ? 1 : 0;
  }
  return mask;
}

function estimateMedian(counts: number[], binStart: number, binWidth: number, total: number): number {
  const half = total / 2;
  let cumulative = 0;
  for (let i = 0; i < counts.length; i++) {
    const next = cumulative + counts[i];
    if (next >= half) {
      const frac = counts[i] > 0 ? (half - cumulative) / counts[i] : 0;
      return binStart + (i + frac) * binWidth;
    }
    cumulative = next;
  }
  return binStart + counts.length * binWidth;
}

function shannonEntropy(counts: number[], total: number): number {
  let entropy = 0;
  const log2 = Math.log(2);
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    entropy -= p * (Math.log(p) / log2);
  }
  return entropy;
}
