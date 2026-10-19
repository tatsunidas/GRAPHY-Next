/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { CONSTANTS } from "@cornerstonejs/core";
import type { SeriesLayoutDto } from "../api";

/**
 * Cornerstone3D の断面の厚み（スラブ）の最小値（mm）。既定が RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS（0.05 mm）で、
 * setSlabThickness は 0.1 mm 未満を切り上げる。これより細かいボクセルでは、1 枚の断面のつもりが何枚も含んでしまい、
 * MPR・3D が正しく描けない（顕微鏡の Z 2 µm で実測。fw/microscopy-cfm.md）。
 */
export const MIN_SLAB_MM: number = CONSTANTS.RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS;

/** ボクセルの一番細かい寸法（mm）。面内の画素間隔と Z の間隔。分からなければ null。 */
export function finestVoxelMm(layout: Pick<SeriesLayoutDto, "pixelSpacingRow" | "pixelSpacingCol" | "zSpatial"> | null): number | null {
  if (!layout) return null;
  const dims: number[] = [layout.pixelSpacingRow, layout.pixelSpacingCol].filter((v) => Number.isFinite(v) && v > 0);
  const zs = layout.zSpatial ?? [];
  if (zs.length >= 2) {
    const a = zs[0].imagePositionPatient, b = zs[zs.length - 1].imagePositionPatient;
    const step = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (zs.length - 1);
    if (step > 0) dims.push(step);
  }
  return dims.length ? Math.min(...dims) : null;
}

/** MPR・3D で描けないほど細かいか（ボクセルがスラブの最小値より細かい）。 */
export function tooFineForVolumeRendering(
  layout: Pick<SeriesLayoutDto, "pixelSpacingRow" | "pixelSpacingCol" | "zSpatial"> | null,
  minSlabMm: number = MIN_SLAB_MM,
): boolean {
  const f = finestVoxelMm(layout);
  return f !== null && f < minSlabMm;
}
