/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * PixelAspectRatio (0028,0034)（画素の縦横比 = 垂直:水平）の扱い。純関数。
 *
 * <p>PixelSpacing・ImagerPixelSpacing・US の領域校正が無い画像（SC・動画・一部の US など）は、mm の寸法を持たないが、
 * 画素が正方でないことがある。表示（vtkImageData の spacing）と world は `imagePlaneModule` の
 * `columnPixelSpacing` / `rowPixelSpacing` で決まるので、**比を間隔として注入**する（列 = 1、行 = 垂直 ÷ 水平。単位は
 * 「水平方向の画素」）。ただし本体の多くの箇所は「間隔が正の数なら mm」と判定するので、注入した間隔には
 * {@link ASPECT_ONLY_KEY} の印を付け、**mm の寸法としては読まない**（px の値に mm を付けない）。
 * mm の寸法が要る箇所は {@link calibratedSpacingOf} を通す。
 */

/** `imagePlaneModule` に付ける印: この間隔は縦横比だけで、mm の寸法ではない。 */
export const ASPECT_ONLY_KEY = "pixelSpacingIsAspectOnly";

/** 1:1 とみなす許容。 */
const UNIT_TOL = 1e-3;

/**
 * PixelAspectRatio の値（"6\5" などの文字列、または数値の配列）→ 比（垂直 ÷ 水平）。
 * 不正・0 以下・1:1 なら null（比を使わない）。
 */
export function parsePixelAspect(v: unknown): number | null {
  let parts: unknown[] = [];
  if (typeof v === "string") parts = v.split("\\");
  else if (Array.isArray(v)) parts = v;
  else return null;
  if (parts.length < 2) return null;
  const vert = Number(typeof parts[0] === "string" ? (parts[0] as string).trim() : parts[0]);
  const horz = Number(typeof parts[1] === "string" ? (parts[1] as string).trim() : parts[1]);
  if (!Number.isFinite(vert) || !Number.isFinite(horz) || vert <= 0 || horz <= 0) return null;
  const ratio = vert / horz;
  return Math.abs(ratio - 1) <= UNIT_TOL ? null : ratio;
}

interface PlaneLike {
  rowPixelSpacing?: number | null;
  columnPixelSpacing?: number | null;
  [key: string]: unknown;
}

/** この `imagePlaneModule` の間隔は縦横比だけか。 */
export function isAspectOnly(plane: PlaneLike | null | undefined): boolean {
  return !!plane && plane[ASPECT_ONLY_KEY] === true;
}

/**
 * mm の寸法としての画素間隔（校正済みのときだけ）。縦横比だけの間隔・間隔が無い・不正なら null（= px で扱う）。
 */
export function calibratedSpacingOf(plane: PlaneLike | null | undefined): { col: number; row: number } | null {
  if (!plane || isAspectOnly(plane)) return null;
  const col = Number(plane.columnPixelSpacing);
  const row = Number(plane.rowPixelSpacing);
  return Number.isFinite(col) && col > 0 && Number.isFinite(row) && row > 0 ? { col, row } : null;
}

/** 縦横比だけの間隔のとき、その比（垂直 ÷ 水平）。それ以外は null。 */
export function aspectOf(plane: PlaneLike | null | undefined): number | null {
  if (!plane || !isAspectOnly(plane)) return null;
  const col = Number(plane.columnPixelSpacing);
  const row = Number(plane.rowPixelSpacing);
  return Number.isFinite(col) && col > 0 && Number.isFinite(row) && row > 0 ? row / col : null;
}
