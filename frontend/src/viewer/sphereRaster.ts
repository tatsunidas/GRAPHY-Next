/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * パラメトリック球（中心 world mm + 半径 mm）を、3D ボリュームの格子上の `LabelVolume` へ
 * ラスタ化する。ボクセル中心が球内（距離 ≤ 半径）なら前景 1。患者 LPS mm で計算し、
 * 格子の向き（direction）にも対応する。
 */
import { voxelToWorld, worldToVoxel, type LabelVolume, type VolumeGeom } from "./labelVolume";

type V3 = [number, number, number];

export function rasterizeSphereToLabelVolume(geom: VolumeGeom, center: V3, radiusMm: number): LabelVolume | null {
  if (!(radiusMm > 0)) return null;
  const [nx, ny, nz] = geom.dims;
  const [sx, sy, sz] = geom.spacing;
  const c = worldToVoxel(geom, center);
  const rx = radiusMm / sx;
  const ry = radiusMm / sy;
  const rz = radiusMm / sz;
  const i0 = Math.max(0, Math.floor(c[0] - rx));
  const i1 = Math.min(nx - 1, Math.ceil(c[0] + rx));
  const j0 = Math.max(0, Math.floor(c[1] - ry));
  const j1 = Math.min(ny - 1, Math.ceil(c[1] + ry));
  const k0 = Math.max(0, Math.floor(c[2] - rz));
  const k1 = Math.min(nz - 1, Math.ceil(c[2] + rz));
  const data = new Uint8Array(nx * ny * nz);
  const r2 = radiusMm * radiusMm;
  let any = false;
  for (let k = k0; k <= k1; k++) {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const w = voxelToWorld(geom, i, j, k);
        const dx = w[0] - center[0];
        const dy = w[1] - center[1];
        const dz = w[2] - center[2];
        if (dx * dx + dy * dy + dz * dz <= r2) {
          data[(k * ny + j) * nx + i] = 1;
          any = true;
        }
      }
    }
  }
  if (!any) return null;
  return { geom, data, voxelMm3: sx * sy * sz };
}
