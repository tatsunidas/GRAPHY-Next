/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 合格率の Wilson 95% 区間（純関数）。件数が少なくても 0〜1 の外へ出ず、0% や 100% でも幅を持つ。
// z は両側 95% の標準正規分布の値（1.959964）。調整する値ではない。
const Z95 = 1.959964;

export interface Proportion {
  passes: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
}

/** n=0（流していない）は null。0 件を 0% と書かず「未取得」にするため。 */
export function wilson95(passes: number, n: number): Proportion | null {
  if (!Number.isInteger(passes) || !Number.isInteger(n) || n <= 0 || passes < 0 || passes > n) return null;
  const p = passes / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { passes, n, rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
