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
 * <p>幾何（IPP/IOP）の有無によらず、ROI の画素座標は左上隅が 0（`roiRead.roiPointsPx` が揃える）。
 *
 * @returns [x(列), y(行)]。画像の外・非有限値は null
 */
export function seedPixelOf(ic: readonly [number, number], cols: number, rows: number): [number, number] | null {
  if (!Number.isFinite(ic[0]) || !Number.isFinite(ic[1])) return null;
  const sx = Math.floor(ic[0]);
  const sy = Math.floor(ic[1]);
  if (sx < 0 || sy < 0 || sx >= cols || sy >= rows) return null;
  return [sx, sy];
}
