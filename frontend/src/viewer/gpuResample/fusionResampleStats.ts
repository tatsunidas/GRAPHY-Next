/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * Fusion のリサンプルの実測（dev ビルドのデバッグ API 用）。本番の経路には何も足さない:
 * 記録は `import.meta.env.DEV` のときだけ呼ばれる（呼び出し側でガードする）。
 */
export interface FusionResampleStats {
  /** 今は CPU だけ。GPU 経路（段 2）が入ったら "gpu-webgl2" と理由が付く。 */
  engine: "cpu";
  reason: "not-implemented";
  /** 直近の computeFusionSlice の所要時間 [ms]。 */
  lastMs: number | null;
  /** リセットからの全サンプル [ms]（上限 MAX_SAMPLES、超えたら古い方から捨てる）。 */
  samples: number[];
  cols: number;
  rows: number;
  fgSlices: number;
  hasTransform: boolean;
}

const MAX_SAMPLES = 2000;
let stats: FusionResampleStats = fresh();

function fresh(): FusionResampleStats {
  return { engine: "cpu", reason: "not-implemented", lastMs: null, samples: [], cols: 0, rows: 0, fgSlices: 0, hasTransform: false };
}

export function recordFusionResample(ms: number, cols: number, rows: number, fgSlices: number, hasTransform: boolean): void {
  stats.lastMs = ms;
  stats.samples.push(ms);
  if (stats.samples.length > MAX_SAMPLES) stats.samples.shift();
  stats.cols = cols; stats.rows = rows; stats.fgSlices = fgSlices; stats.hasTransform = hasTransform;
}

export function resetFusionResampleStats(): void {
  stats = fresh();
}

export function getFusionResampleStats(): FusionResampleStats {
  return { ...stats, samples: stats.samples.slice() };
}
