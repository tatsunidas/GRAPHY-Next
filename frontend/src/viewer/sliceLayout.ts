/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D 体積のスライスの並び（純関数）。
 *
 * <p>Cornerstone の体積は<b>等間隔を前提</b>に組まれる（間隔は先頭と中央の距離から 1 つだけ求める）。
 * 間隔が不均一なシリーズ（欠けたスライス・間引いたシリーズ）では、k 枚目の画像が描かれる位置
 * （origin + k·sz）と実際の IPP が食い違う。ROI を IPP から k に直すと、画像とは別のスライスに載ってしまう。
 * そこで ROI のフレームは、参照している画像（SOP）で体積の k 枚目に当てる（＝描かれている画像と同じ所）。
 */

export interface SliceSpacingReport {
  /** 隣り合うスライスの法線方向の間隔（mm、並び順）。 */
  steps: number[];
  /** すべての間隔が中央値と一致するか（許容は中央値の 1 % か 0.01 mm の大きい方）。 */
  uniform: boolean;
  /** 同じ位置に重なっているスライスの組の数。 */
  duplicates: number;
}

/** 法線方向の位置（並び替え済み）から、間隔が等しいかを調べる。 */
export function sliceSpacingReport(positions: ReadonlyArray<number>): SliceSpacingReport {
  const steps: number[] = [];
  for (let i = 1; i < positions.length; i++) steps.push(positions[i] - positions[i - 1]);
  const abs = steps.map(Math.abs);
  const sorted = [...abs].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const tol = Math.max(0.01, median * 0.01);
  const duplicates = abs.filter((s) => s <= 0.01).length;
  const uniform = duplicates === 0 && abs.every((s) => Math.abs(s - median) <= tol);
  return { steps, uniform, duplicates };
}

/** 並び順の SOP Instance UID 列 → SOP ごとの体積上のスライス番号。 */
export function sopIndexMap(sops: ReadonlyArray<string | null | undefined>): Map<string, number> {
  const m = new Map<string, number>();
  sops.forEach((s, k) => {
    if (s && !m.has(s)) m.set(s, k);
  });
  return m;
}
