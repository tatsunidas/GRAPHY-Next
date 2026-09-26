/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D SLAB モードのスラブ面幾何（純関数・患者 LPS mm）。fw/slab-mip-design.md §A。
 *
 * スラブ面はカメラに固定する: 法線 = 視線方向（direction of projection）、原点 = 焦点 + 法線 × depth。
 * 回転すれば任意斜めスラブ、Pan は面内移動（depth 不変）、depth は視線方向の前後スライド。
 */

export type Vec3 = [number, number, number];

function norm(v: readonly number[]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

/** カメラ（焦点・視線方向）と depth(mm) からスラブ面（原点・単位法線）を返す。 */
export function slabPlaneFromCamera(
  focalPoint: readonly number[],
  directionOfProjection: readonly number[],
  depthMm: number,
): { origin: Vec3; normal: Vec3 } {
  const n = norm(directionOfProjection);
  return {
    origin: [focalPoint[0] + n[0] * depthMm, focalPoint[1] + n[1] * depthMm, focalPoint[2] + n[2] * depthMm],
    normal: n,
  };
}

/** depth スライダーの可動域(mm) = ボリューム外接箱の対角の半分（どの向きでも全域を通れる）。 */
export function maxSlabDepthMm(bounds: readonly number[]): number {
  if (bounds.length < 6) return 0;
  const dx = bounds[1] - bounds[0];
  const dy = bounds[3] - bounds[2];
  const dz = bounds[5] - bounds[4];
  return Math.hypot(dx, dy, dz) / 2;
}

/** depth を ±可動域へ丸める。 */
export function clampSlabDepth(depthMm: number, maxMm: number): number {
  if (!Number.isFinite(depthMm)) return 0;
  return Math.max(-maxMm, Math.min(maxMm, depthMm));
}
