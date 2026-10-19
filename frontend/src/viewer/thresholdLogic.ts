/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * しきい値（範囲）の純ロジック。Cornerstone に依存しない（vitest で検査する）。
 * 判定は Wand と同じ {@link inRange}（両端を含む）。
 */
import { inRange } from "./wandFlood";

/**
 * 画素 0..n-1 のうち、判定値が [lower, upper] に入る添字を昇順で返す。
 * lower > upper や NaN の境界は何も選ばない（誤って全域を塗らない）。
 */
export function selectInRange(read: (i: number) => number, n: number, lower: number, upper: number): number[] {
  const out: number[] = [];
  if (!(lower <= upper)) return out;
  for (let i = 0; i < n; i++) {
    if (inRange(read(i), lower, upper)) out.push(i);
  }
  return out;
}
