/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * クリック位置（画素座標）から、シードにする画素の添字を決める。純関数。
 *
 * <p>画素座標は左上隅が 0・画素 i の中心が i+0.5（`imageCoords.worldToImageOnPlane`）。画素 i は [i, i+1) なので、
 * 押した位置を含む画素は `floor`。`round` だと画素の右半分・下半分を押したとき隣の画素を掴む。
 *
 *
 * <p>**幾何（IPP/IOP）の無い画像（XA など）は規約が違う**。`roiRead.roiPointsPx` のフォールバック（world ÷ 画素間隔）は
 * 画素 (0,0) の**中心**が原点なので、画素 i の中心が整数 i（画素 i は [i−0.5, i+0.5)）。その座標には `round` が正しい
 * （`origin: "center"`）。実機（XA の合成画像）で、`floor` だと左半分・上半分で隣の画素を掴むことを確かめた。
 *
 * @param origin "corner": 左上隅が 0（幾何あり。既定）／ "center": 画素 (0,0) の中心が 0（幾何なしのフォールバック）
 * @returns [x(列), y(行)]。画像の外・非有限値は null
 */
export function seedPixelOf(
  ic: readonly [number, number],
  cols: number,
  rows: number,
  origin: "corner" | "center" = "corner",
): [number, number] | null {
  if (!Number.isFinite(ic[0]) || !Number.isFinite(ic[1])) return null;
  const f = origin === "center" ? Math.round : Math.floor;
  const sx = f(ic[0]);
  const sy = f(ic[1]);
  if (sx < 0 || sy < 0 || sx >= cols || sy >= rows) return null;
  return [sx, sy];
}
