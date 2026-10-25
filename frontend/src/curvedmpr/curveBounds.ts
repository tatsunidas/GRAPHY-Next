/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Curved MPR の物理(LPS mm) ↔ 連続ボクセル index と、制御点のボリューム範囲判定（純関数）。
 *
 * 範囲外の点を含む中心線の再構成は、範囲外のサンプルに固定値（空気値）が入る。
 * 実データではない値が正常な絵に見えるので、窓は件数を数えて警告する（切り詰めも黙認もしない）。
 */
import type { ResliceVolume, Vec3 } from "../viewer/reslice";

/** 物理(LPS mm) → 連続ボクセル index (i,j,k)。direction は正規直交前提。 */
export function toVoxelIndex(vol: ResliceVolume, p: Vec3): Vec3 {
  const d = vol.direction, o = vol.origin, s = vol.spacing;
  const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
  return [
    (dx * d[0] + dy * d[1] + dz * d[2]) / s[0],
    (dx * d[3] + dy * d[4] + dz * d[5]) / s[1],
    (dx * d[6] + dy * d[7] + dz * d[8]) / s[2],
  ];
}

export interface OutOfBoundsSummary {
  total: number;
  outside: number;
  /** 最初に範囲外だった点（LPS mm）。 */
  first: Vec3 | null;
}

/** 制御点のうち、ボクセル中心の範囲 [0, dim-1] の外にある点を数える（補間が成り立つ範囲）。 */
export function countOutOfBounds(
  vol: Pick<ResliceVolume, "direction" | "origin" | "spacing" | "dimensions">,
  points: readonly Vec3[],
): OutOfBoundsSummary {
  let outside = 0;
  let first: Vec3 | null = null;
  for (const p of points) {
    const [i, j, k] = toVoxelIndex(vol as ResliceVolume, p);
    const [W, H, D] = vol.dimensions;
    if (!(i >= 0 && i <= W - 1 && j >= 0 && j <= H - 1 && k >= 0 && k <= D - 1)) {
      outside++;
      if (!first) first = [p[0], p[1], p[2]];
    }
  }
  return { total: points.length, outside, first };
}
