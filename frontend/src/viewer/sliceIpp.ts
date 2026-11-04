/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * スライス 1 枚の患者座標の位置（ImagePositionPatient）をメタデータから取る。
 *
 * <p>プラグイン host API の H3（`getPixelData`）が返す。**タイルのスライス番号と、H10 のボリュームの
 * z 添字は同じとは限らない**ので、プラグインが位置で対応づけるための材料（`ViewerPixelData.ipp`）。
 * 無い・数値でないときは null（**0 を捏造しない**）。
 */
import { metaData } from "@cornerstonejs/core";

/** `imagePlaneModule` から位置を取り出す（純関数）。3 つの有限な数値でなければ null。 */
export function ippFromPlane(plane: { imagePositionPatient?: unknown } | null | undefined): [number, number, number] | null {
  const a = plane?.imagePositionPatient;
  if (!Array.isArray(a) || a.length < 3) return null;
  const x = Number(a[0]);
  const y = Number(a[1]);
  const z = Number(a[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

export function sliceIppOf(imageId: string): [number, number, number] | null {
  try {
    return ippFromPlane(metaData.get("imagePlaneModule", imageId) as { imagePositionPatient?: unknown } | undefined);
  } catch {
    return null;
  }
}
