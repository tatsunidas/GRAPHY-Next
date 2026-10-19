/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM RTSTRUCT の輪郭（患者座標 mm）を、3D Viewer が表示中のボリューム幾何（`geom`）に対応した
 * `LabelVolume` へ直接ラスタライズする。2D ビューアの `rtstructImport.ts` は Cornerstone の 2D stack
 * viewport 上へ構造ごとの Mask として復元するが、
 * 3D Viewer は 2D stack viewport を持たないため、輪郭点を偶奇規則で voxel 平面へ直接塗りつぶす
 * （`maskFrames.ts` の `framesToLabelVolume` の RTSTRUCT 版）。
 *
 * 各輪郭（ContourData）は単一スライス上の閉ポリゴンである前提（RT Structure Set の仕様どおり）。
 * voxel index は `worldToVoxel` によりピクセル中心が整数座標に対応する（`framesToLabelVolume` と同じ
 * 前提）。同じスライスの閉輪郭はまとめて偶奇で塗る（穴を保つ）。閉輪郭以外は塗らない。
 */
import type { RtStructImportRoi } from "../api";
import { fillPolygonsEvenOdd } from "./maskContour";
import { worldToVoxel, type LabelVolume, type VolumeGeom } from "./labelVolume";

/**
 * 1 スライス分の閉ポリゴン群（voxel 平面座標＝ピクセル中心が整数）を偶奇で塗る。
 * 2D 側（`rtstructRaster.ts`）と同じ関数に合わせるため、角原点の座標（中心が +0.5）へ半画素ずらす。
 * 穴は別の閉輪郭で入っているので、スライスの輪郭をまとめて塗らないと穴が埋まる。
 */
export function fillSliceEvenOdd(polys: ReadonlyArray<ReadonlyArray<[number, number]>>, nx: number, ny: number): Uint8Array {
  const shifted = polys.map((p) => p.map(([x, y]): [number, number] => [x + 0.5, y + 0.5]));
  return fillPolygonsEvenOdd(shifted, nx, ny);
}

/**
 * RTSTRUCT の 1 ROI（輪郭群）を `LabelVolume` へラスタライズする。前景が無ければ null。
 * 面内解像度・向きが `geom` と一致している前提（ウィンドウ間マスク同期の `framesToLabelVolume` と同様、
 * 不一致は検出しない）。
 */
export function rtStructRoiToLabelVolume(
  roi: RtStructImportRoi,
  geom: VolumeGeom,
  value = 1,
  sopToK?: ReadonlyMap<string, number>,
): LabelVolume | null {
  const [nx, ny, nz] = geom.dims;
  const data = new Uint8Array(nx * ny * nz);
  let any = false;
  const polysByK = new Map<number, [number, number][][]>();
  for (const c of roi.contours) {
    if ((c.geometricType || "CLOSED_PLANAR") !== "CLOSED_PLANAR") continue;
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
    // 参照画像（SOP）が体積にあれば、その画像が描かれている k に載せる（不均一な間隔でも画像と合う）。
    const bySop = c.referencedSopInstanceUid ? sopToK?.get(c.referencedSopInstanceUid) : undefined;
    const k = bySop ?? Math.round(kSum / kCount);
    if (k < 0 || k >= nz) continue;
    const list = polysByK.get(k) ?? [];
    list.push(voxelPts);
    polysByK.set(k, list);
  }
  for (const [k, polys] of polysByK) {
    const fg = fillSliceEvenOdd(polys, nx, ny);
    const base = k * nx * ny;
    for (let i = 0; i < fg.length; i++) {
      if (fg[i]) {
        data[base + i] = value;
        any = true;
      }
    }
  }
  if (!any) return null;
  const voxelMm3 = geom.spacing[0] * geom.spacing[1] * geom.spacing[2];
  return { geom, data, voxelMm3 };
}
