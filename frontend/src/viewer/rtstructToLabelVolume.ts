/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM RTSTRUCT の輪郭（患者座標 mm）を、3D Viewer が表示中のボリューム幾何（`geom`）に対応した
 * `LabelVolume` へ直接ラスタライズする。2D ビューアの `rtstructImport.ts` は Cornerstone の 2D stack
 * viewport 上へ PlanarFreehandROI アノテーションとして復元してから `roiToMask` で Mask 化するが、
 * 3D Viewer は 2D stack viewport を持たないため、輪郭点を偶奇規則で voxel 平面へ直接塗りつぶす
 * （`maskFrames.ts` の `framesToLabelVolume` の RTSTRUCT 版）。
 *
 * 各輪郭（ContourData）は単一スライス上の閉ポリゴンである前提（RT Structure Set の仕様どおり）。
 * voxel index は `worldToVoxel` によりピクセル中心が整数座標に対応する（`framesToLabelVolume` と同じ
 * 前提）ため、走査線は整数 y 上でサンプリングする。
 */
import type { RtStructImportRoi } from "../api";
import { worldToVoxel, type LabelVolume, type VolumeGeom } from "./labelVolume";

/** 単一スライス（voxel 平面座標のポリゴン）を偶奇規則で塗りつぶす。前景を書けたら true。 */
function fillPolygon(
  data: Uint8Array,
  base: number,
  nx: number,
  ny: number,
  pts: [number, number][],
  value: number,
): boolean {
  if (pts.length < 3) return false;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const y0 = Math.max(0, Math.ceil(minY));
  const y1 = Math.min(ny - 1, Math.floor(maxY));
  let any = false;
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1p] = pts[i];
      const [x2, y2p] = pts[(i + 1) % pts.length];
      if ((y1p <= y && y2p > y) || (y2p <= y && y1p > y)) {
        xs.push(x1 + ((y - y1p) / (y2p - y1p)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xStart = Math.max(0, Math.ceil(xs[i]));
      const xEnd = Math.min(nx - 1, Math.floor(xs[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        data[base + y * nx + x] = value;
        any = true;
      }
    }
  }
  return any;
}

/**
 * RTSTRUCT の 1 ROI（輪郭群）を `LabelVolume` へラスタライズする。前景が無ければ null。
 * 面内解像度・向きが `geom` と一致している前提（ウィンドウ間マスク同期の `framesToLabelVolume` と同様、
 * 不一致は検出しない）。
 */
export function rtStructRoiToLabelVolume(roi: RtStructImportRoi, geom: VolumeGeom, value = 1): LabelVolume | null {
  const [nx, ny, nz] = geom.dims;
  const data = new Uint8Array(nx * ny * nz);
  let any = false;
  for (const c of roi.contours) {
    const pts = c.points;
    if (!pts || pts.length < 9) continue;
    const voxelPts: [number, number][] = [];
    let kSum = 0;
    let kCount = 0;
    for (let i = 0; i + 2 < pts.length; i += 3) {
      const v = worldToVoxel(geom, [pts[i], pts[i + 1], pts[i + 2]]);
      voxelPts.push([v[0], v[1]]);
      kSum += v[2];
      kCount++;
    }
    if (!kCount) continue;
    const k = Math.round(kSum / kCount);
    if (k < 0 || k >= nz) continue;
    if (fillPolygon(data, k * nx * ny, nx, ny, voxelPts, value)) any = true;
  }
  if (!any) return null;
  const voxelMm3 = geom.spacing[0] * geom.spacing[1] * geom.spacing[2];
  return { geom, data, voxelMm3 };
}
