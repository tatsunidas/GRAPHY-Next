/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * Fusion のリサンプルの実測（dev ビルドのデバッグ API 用）。本番の経路には何も足さない:
 * 記録は `import.meta.env.DEV` のときだけ呼ばれる（呼び出し側でガードする）。
 */
export interface FusionResampleStats {
  /** 直近の背景スライスに使った経路。 */
  engine: "cpu" | "gpu-webgl2";
  /** CPU のとき、その理由（setting-cpu・software・parity-failed・slower・dvf など）。GPU のときは null。 */
  reason: string | null;
  /** 判定の記録（一致検査・時間・カナリア）。判定前は null。 */
  decision: FusionResampleDecision | null;
  /** 直近の computeFusionSlice の所要時間 [ms]。 */
  lastMs: number | null;
  /** リセットからの全サンプル [ms]（上限 MAX_SAMPLES、超えたら古い方から捨てる）。 */
  samples: number[];
  cols: number;
  rows: number;
  fgSlices: number;
  hasTransform: boolean;
}

/** GPU を使うかの判定の記録（fusionResampler.ts が作る）。 */
export interface FusionResampleDecision {
  engine: "cpu" | "gpu-webgl2";
  reason: string | null;
  /** 実データの最初の背景スライスでの一致検査（GPU と CPU を両方計算した結果）。 */
  parity: { pixels: number; valid: number; violations: number; ambiguous: number; maxRatio: number } | null;
  /** 同じスライスの所要時間 [ms]（各 3 回の中央値。GPU はアップロード済み・読み戻し込み）。 */
  cpuMs: number | null;
  gpuMs: number | null;
  /** その GPU での最初の一致検査（合成ボリューム）。 */
  canary: { ok: boolean; violations: number; maxRatio: number; cases: number } | null;
}

const MAX_SAMPLES = 2000;
let stats: FusionResampleStats = fresh();

function fresh(): FusionResampleStats {
  return { engine: "cpu", reason: "not-evaluated", decision: null, lastMs: null, samples: [], cols: 0, rows: 0, fgSlices: 0, hasTransform: false };
}

export function recordFusionResample(ms: number, cols: number, rows: number, fgSlices: number, hasTransform: boolean): void {
  stats.lastMs = ms;
  stats.samples.push(ms);
  if (stats.samples.length > MAX_SAMPLES) stats.samples.shift();
  stats.cols = cols; stats.rows = rows; stats.fgSlices = fgSlices; stats.hasTransform = hasTransform;
}

/** 経路と判定の記録（fusionResampler が更新する）。サンプルは消さない。 */
export function setFusionEngineInfo(engine: "cpu" | "gpu-webgl2", reason: string | null, decision?: FusionResampleDecision | null): void {
  stats.engine = engine;
  stats.reason = reason;
  if (decision !== undefined) stats.decision = decision;
}

export function resetFusionResampleStats(): void {
  stats = fresh();
}

export function getFusionResampleStats(): FusionResampleStats {
  return { ...stats, samples: stats.samples.slice() };
}
