/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D ROI ↔ メッシュの**確定変換**（`fw/3d-viewer-design.md` §8.2-8.3）。全て患者 LPS mm（要件 11）。
 *
 * ● ROI → メッシュ（marching cubes）:
 *   `vtkImageMarchingCubes` を **isovalue 0.5** で実行。ただし本フィルタは **direction 行列を無視**し
 *   `origin + index*spacing` で頂点を出す（＝旧 GRAPHY が捨てていた "voxel×spacing" の軸整列格子）。
 *   そこで **origin=0 / direction=I の局所 imageData** で MC を回し、出力頂点 v(=index*spacing) を
 *   `world = origin + R·v`（R=IOP 由来 direction）へ**後段変換**して**真の LPS 頂点**を得る。
 *   平滑化は `vtkWindowedSincPolyDataFilter`（Laplacian より収縮が少ない）＋法線再計算。
 *
 * ● メッシュ → 3D ROI（voxelize）:
 *   vtk.js に `PolyDataToImageStencil` が無いため、**実空間スキャンライン parity fill を自前実装**。
 *   メッシュ頂点を対象幾何の **index 空間へ逆変換**（`worldToVoxel`）し、各 (y,z) 走査線に沿って
 *   三角形交点 x を集め、偶奇塗り分けで内部ボクセルを埋める（閉じた多様体メッシュ前提）。
 */
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkImageMarchingCubes from "@kitware/vtk.js/Filters/General/ImageMarchingCubes";
import vtkWindowedSincPolyDataFilter from "@kitware/vtk.js/Filters/General/WindowedSincPolyDataFilter";
import {
  type LabelVolume,
  type VolumeGeom,
  emptyLabelVolume,
} from "./labelVolume";
import { getMeshArrays, withNormals } from "./mesh3d";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface RoiToMeshOptions {
  /** 平滑化反復数（0 で無効）。既定 15。 */
  smoothIterations?: number;
  /** WindowedSinc の pass band（0..2, 小さいほど強い平滑）。既定 0.1。 */
  passBand?: number;
}

/**
 * LabelVolume（実空間 labelmap）→ メッシュ（`vtkPolyData`, 患者 LPS mm）。
 * 前景ゼロ/失敗時は null。
 */
export function labelVolumeToMesh(lv: LabelVolume, opts: RoiToMeshOptions = {}): Any | null {
  try {
    const { dims, spacing, origin, direction } = lv.geom;
    const [nx, ny, nz] = dims;
    if (nx * ny * nz !== lv.data.length) return null;

    // origin=0 / direction=I の局所 imageData で MC を回す（direction 無視バグを後段変換で吸収）。
    const local: Any = vtkImageData.newInstance();
    local.setDimensions(nx, ny, nz);
    local.setSpacing(spacing[0], spacing[1], spacing[2]);
    // origin は既定 [0,0,0]、direction は既定 I。
    const scalars = vtkDataArray.newInstance({
      numberOfComponents: 1,
      values: Float32Array.from(lv.data),
    });
    local.getPointData().setScalars(scalars);

    const mc: Any = vtkImageMarchingCubes.newInstance();
    mc.setInputData(local);
    mc.setContourValue(0.5);
    mc.setComputeNormals?.(false);
    mc.setMergePoints?.(true);
    let pd: Any = mc.getOutputData();
    if (!pd || pd.getNumberOfPoints?.() === 0) return null;

    // 平滑化（局所空間で。剛体変換と可換なので順序不問）。
    const iters = opts.smoothIterations ?? 15;
    if (iters > 0) {
      try {
        const smooth: Any = vtkWindowedSincPolyDataFilter.newInstance();
        smooth.setInputData(pd);
        smooth.setNumberOfIterations(iters);
        smooth.setPassBand?.(opts.passBand ?? 0.1);
        smooth.setFeatureEdgeSmoothing?.(false);
        smooth.setBoundarySmoothing?.(true);
        const out = smooth.getOutputData();
        if (out && out.getNumberOfPoints?.() > 0) pd = out;
      } catch {
        /* 平滑化失敗時は生 MC を使う */
      }
    }

    // 頂点を world（患者 LPS mm）へ: world = origin + R·v_local。
    transformPointsToWorld(pd, origin, direction);
    return withNormals(pd);
  } catch {
    return null;
  }
}

/** polydata の頂点を local(index*spacing) → world(origin + R·v) へ in-place 変換。 */
function transformPointsToWorld(pd: Any, origin: number[], d: number[]): void {
  const pts = pd.getPoints();
  const data = pts.getData() as Float32Array | Float64Array;
  const out = new Float64Array(data.length);
  for (let i = 0; i < data.length; i += 3) {
    const vx = data[i], vy = data[i + 1], vz = data[i + 2];
    out[i] = origin[0] + d[0] * vx + d[1] * vy + d[2] * vz;
    out[i + 1] = origin[1] + d[3] * vx + d[4] * vy + d[5] * vz;
    out[i + 2] = origin[2] + d[6] * vx + d[7] * vy + d[8] * vz;
  }
  pts.setData(out, 3);
  pts.modified();
  pd.modified?.();
}

/**
 * メッシュ（`vtkPolyData`, 患者 LPS mm）→ LabelVolume（`geom` 幾何にラスタ化）。
 * 閉じた多様体前提のスキャンライン parity fill。空/失敗時は null。
 */
export function meshToLabelVolume(polydata: Any, geom: VolumeGeom): LabelVolume | null {
  try {
    const { points, tris } = getMeshArrays(polydata);
    if (!tris.length) return null;
    const [nx, ny, nz] = geom.dims;
    const { origin: o, spacing: s, direction: d } = geom;

    // 頂点を index 空間へ逆変換: idx = (R^T·(w−origin)) / spacing。
    const np = points.length / 3;
    const ip = new Float64Array(np * 3);
    for (let p = 0; p < np; p++) {
      const wx = points[p * 3] - o[0];
      const wy = points[p * 3 + 1] - o[1];
      const wz = points[p * 3 + 2] - o[2];
      const l0 = d[0] * wx + d[3] * wy + d[6] * wz;
      const l1 = d[1] * wx + d[4] * wy + d[7] * wz;
      const l2 = d[2] * wx + d[5] * wy + d[8] * wz;
      ip[p * 3] = l0 / (s[0] || 1); // i (x)
      ip[p * 3 + 1] = l1 / (s[1] || 1); // j (y)
      ip[p * 3 + 2] = l2 / (s[2] || 1); // k (z)
    }

    // (j,k) 走査線ごとの x 交点リスト。index = k*ny + j。
    const crossings: number[][] = new Array(ny * nz);

    const push = (k: number, j: number, x: number) => {
      if (k < 0 || k >= nz || j < 0 || j >= ny) return;
      const idx = k * ny + j;
      (crossings[idx] ?? (crossings[idx] = [])).push(x);
    };

    // 各三角形を (y,z) 平面に射影し、走査線 (j+0.5, k+0.5) との交点 x を集める。
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ax = ip[a], ay = ip[a + 1], az = ip[a + 2];
      const bx = ip[b], by = ip[b + 1], bz = ip[b + 2];
      const cx = ip[c], cy = ip[c + 1], cz = ip[c + 2];

      // (y,z) の bbox → 走査対象 j,k 範囲。
      const ymin = Math.min(ay, by, cy), ymax = Math.max(ay, by, cy);
      const zmin = Math.min(az, bz, cz), zmax = Math.max(az, bz, cz);
      const j0 = Math.max(0, Math.ceil(ymin - 0.5));
      const j1 = Math.min(ny - 1, Math.floor(ymax - 0.5));
      const k0 = Math.max(0, Math.ceil(zmin - 0.5));
      const k1 = Math.min(nz - 1, Math.floor(zmax - 0.5));
      if (j0 > j1 || k0 > k1) continue;

      // (y,z) 平面での 2D 面積（符号付き）。u=(B-A), v=(C-A) の 2D cross。
      const uy = by - ay, uz = bz - az;
      const vy = cy - ay, vz = cz - az;
      const area = uy * vz - uz * vy;
      if (Math.abs(area) < 1e-9) continue; // 退化（エッジオン）三角形はスキップ
      const invArea = 1 / area;

      for (let k = k0; k <= k1; k++) {
        const kk = k + 0.5;
        for (let j = j0; j <= j1; j++) {
          const jj = j + 0.5;
          // 点 P=(jj,kk) の重心座標。
          const py = jj - ay, pz = kk - az;
          // wB = ((P-A) x (C-A)) / area ; wC = ((B-A) x (P-A)) / area
          const wB = (py * vz - pz * vy) * invArea;
          const wC = (uy * pz - uz * py) * invArea;
          const wA = 1 - wB - wC;
          const eps = -1e-9;
          if (wA < eps || wB < eps || wC < eps) continue;
          // x = 重心補間。
          const x = wA * ax + wB * bx + wC * cx;
          push(k, j, x);
        }
      }
    }

    // parity fill。
    const lv = emptyLabelVolume(geom);
    const data = lv.data;
    const frame = nx * ny;
    let any = false;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const xs = crossings[k * ny + j];
        if (!xs || xs.length < 2) continue;
        xs.sort((p, q) => p - q);
        for (let m = 0; m + 1 < xs.length; m += 2) {
          const x0 = xs[m], x1 = xs[m + 1];
          const i0 = Math.max(0, Math.ceil(x0 - 0.5));
          const i1 = Math.min(nx - 1, Math.floor(x1 - 0.5));
          const rowBase = k * frame + j * nx;
          for (let i = i0; i <= i1; i++) {
            data[rowBase + i] = 1;
            any = true;
          }
        }
      }
    }
    if (!any) return null;
    return lv;
  } catch {
    return null;
  }
}
