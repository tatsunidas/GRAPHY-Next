/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * メッシュモデル・I/O・計測（`fw/3d-viewer-design.md` §8.4-8.6）。
 *
 * メッシュは `vtkPolyData`（頂点は**患者 LPS mm**）。描画は `vtkActor`+`vtkMapper`（色/透明度/可視）。
 * 計測（体積/表面積/主径）は vtk.js に `vtkMassProperties` が同梱されないため**自前 real-space 計算**:
 *  - 体積 = Σ v0·(v1×v2)/6（発散定理。回転/平行移動不変）
 *  - 表面積 = Σ ½|（v1−v0）×（v2−v0）|
 *  - 主径 = 頂点共分散の PCA（Jacobi）＋各固有ベクトル方向の投影範囲（long/mid/short）
 * これは旧 GRAPHY `MeshAnalyzer` と等価（設計 §8.5）。
 *
 * STL は `vtkSTLReader/Writer`（binary）。頂点は患者 LPS mm で入出力（座標系メタは STL に無いため UI で明示）。
 */
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkSTLReader from "@kitware/vtk.js/IO/Geometry/STLReader";
import vtkSTLWriter from "@kitware/vtk.js/IO/Geometry/STLWriter";
import vtkOBJReader from "@kitware/vtk.js/IO/Misc/OBJReader";
import vtkTriangleFilter from "@kitware/vtk.js/Filters/General/TriangleFilter";
import vtkPolyDataNormals from "@kitware/vtk.js/Filters/Core/PolyDataNormals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type V3 = [number, number, number];

/** メッシュ計測結果（患者 LPS mm）。 */
export interface MeshMeasurements {
  numPoints: number;
  numTriangles: number;
  volumeMm3: number;
  volumeMl: number;
  surfaceAreaMm2: number;
  /** 主径 [long, mid, short]（mm, PCA 軸投影範囲）。 */
  diameters: [number, number, number];
  /** AABB [min, max]（world mm）。 */
  boundsMin: V3;
  boundsMax: V3;
}

/** メッシュ描画アクター（色/透明度/可視）。 */
export interface MeshActor {
  actor: Any;
  mapper: Any;
}

/** polydata から頂点(Float)・三角形(flat index)を取り出す。非三角形は三角化してから。 */
export function getMeshArrays(polydata: Any): { points: Float64Array; tris: Uint32Array } {
  const pts = polydata.getPoints()?.getData() as ArrayLike<number> | undefined;
  const polys = polydata.getPolys()?.getData() as ArrayLike<number> | undefined;
  const points = pts ? Float64Array.from(pts) : new Float64Array(0);
  const tris: number[] = [];
  if (polys) {
    let i = 0;
    while (i < polys.length) {
      const n = polys[i++];
      if (n < 3) {
        i += n;
        continue;
      }
      const i0 = polys[i];
      // fan-triangulate 任意多角形（marching cubes は既に三角形）。
      for (let k = 1; k < n - 1; k++) {
        tris.push(i0, polys[i + k], polys[i + k + 1]);
      }
      i += n;
    }
  }
  return { points, tris: Uint32Array.from(tris) };
}

/** メッシュを計測（体積/表面積/主径/AABB）。 */
export function measureMesh(polydata: Any): MeshMeasurements {
  const { points, tris } = getMeshArrays(polydata);
  const np = points.length / 3;
  const nt = tris.length / 3;

  let vol6 = 0; // 6×体積
  let area2 = 0; // 2×面積の Σ|cross| 用
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ax = points[a], ay = points[a + 1], az = points[a + 2];
    const bx = points[b], by = points[b + 1], bz = points[b + 2];
    const cx = points[c], cy = points[c + 1], cz = points[c + 2];
    // 発散定理: 符号付き四面体体積 = a·(b×c)/6
    vol6 +=
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx);
    // 面積: ½|（b−a）×（c−a）|
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    area2 += Math.hypot(nx, ny, nz);
  }
  const volumeMm3 = Math.abs(vol6) / 6;
  const surfaceAreaMm2 = area2 / 2;

  // AABB。
  const bmin: V3 = [Infinity, Infinity, Infinity];
  const bmax: V3 = [-Infinity, -Infinity, -Infinity];
  for (let p = 0; p < points.length; p += 3) {
    for (let d = 0; d < 3; d++) {
      const v = points[p + d];
      if (v < bmin[d]) bmin[d] = v;
      if (v > bmax[d]) bmax[d] = v;
    }
  }
  if (!np) {
    bmin[0] = bmin[1] = bmin[2] = 0;
    bmax[0] = bmax[1] = bmax[2] = 0;
  }

  const diameters = principalDiameters(points);
  return {
    numPoints: np,
    numTriangles: nt,
    volumeMm3,
    volumeMl: volumeMm3 / 1000,
    surfaceAreaMm2,
    diameters,
    boundsMin: bmin,
    boundsMax: bmax,
  };
}

/** 頂点共分散の PCA → 各主軸方向の投影範囲 [long, mid, short] mm。 */
function principalDiameters(points: Float64Array): [number, number, number] {
  const n = points.length / 3;
  if (n < 2) return [0, 0, 0];
  let cx = 0, cy = 0, cz = 0;
  for (let p = 0; p < points.length; p += 3) {
    cx += points[p];
    cy += points[p + 1];
    cz += points[p + 2];
  }
  cx /= n; cy /= n; cz /= n;
  // 共分散 3×3。
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let p = 0; p < points.length; p += 3) {
    const dx = points[p] - cx, dy = points[p + 1] - cy, dz = points[p + 2] - cz;
    xx += dx * dx; yy += dy * dy; zz += dz * dz;
    xy += dx * dy; xz += dx * dz; yz += dy * dz;
  }
  const cov = [
    [xx / n, xy / n, xz / n],
    [xy / n, yy / n, yz / n],
    [xz / n, yz / n, zz / n],
  ];
  const vecs = jacobiEigenvectors(cov);
  // 各固有ベクトル方向の投影範囲。
  const ranges: number[] = vecs.map((v) => {
    let mn = Infinity, mx = -Infinity;
    for (let p = 0; p < points.length; p += 3) {
      const proj = points[p] * v[0] + points[p + 1] * v[1] + points[p + 2] * v[2];
      if (proj < mn) mn = proj;
      if (proj > mx) mx = proj;
    }
    return mx - mn;
  });
  ranges.sort((a, b) => b - a);
  return [ranges[0] || 0, ranges[1] || 0, ranges[2] || 0];
}

/** 対称 3×3 行列の固有ベクトル（Jacobi 回転）。3 本の単位ベクトルを返す。 */
function jacobiEigenvectors(a: number[][]): V3[] {
  // a をコピー（破壊的）。
  const m = a.map((r) => r.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    // 最大の非対角要素。
    let p = 0, q = 1;
    let off = Math.abs(m[0][1]);
    if (Math.abs(m[0][2]) > off) { off = Math.abs(m[0][2]); p = 0; q = 2; }
    if (Math.abs(m[1][2]) > off) { off = Math.abs(m[1][2]); p = 1; q = 2; }
    if (off < 1e-12) break;
    const app = m[p][p], aqq = m[q][q], apq = m[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi), s = Math.sin(phi);
    // 回転を m と v に適用。
    for (let k = 0; k < 3; k++) {
      const mkp = m[k][p], mkq = m[k][q];
      m[k][p] = c * mkp - s * mkq;
      m[k][q] = s * mkp + c * mkq;
    }
    for (let k = 0; k < 3; k++) {
      const mpk = m[p][k], mqk = m[q][k];
      m[p][k] = c * mpk - s * mqk;
      m[q][k] = s * mpk + c * mqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p], vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  // 固有値 = 対角、固有ベクトル = v の列。
  return [
    [v[0][0], v[1][0], v[2][0]],
    [v[0][1], v[1][1], v[2][1]],
    [v[0][2], v[1][2], v[2][2]],
  ];
}

/** polydata から描画アクターを作る。 */
export function makeSurfaceActor(
  polydata: Any,
  opts: { color: V3; opacity: number; visible?: boolean },
): MeshActor {
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(polydata);
  mapper.setScalarVisibility(false); // 単色。per-vertex 色は使わない。
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  prop.setColor(opts.color[0], opts.color[1], opts.color[2]);
  prop.setOpacity(opts.opacity);
  prop.setInterpolationToPhong?.();
  actor.setVisibility(opts.visible !== false);
  return { actor, mapper };
}

/** アクターの色/透明度/可視を更新。 */
export function updateActorAppearance(
  ma: MeshActor,
  opts: { color?: V3; opacity?: number; visible?: boolean },
): void {
  const prop = ma.actor.getProperty();
  if (opts.color) prop.setColor(opts.color[0], opts.color[1], opts.color[2]);
  if (opts.opacity != null) prop.setOpacity(opts.opacity);
  if (opts.visible != null) ma.actor.setVisibility(opts.visible);
}

/** 法線を計算した polydata を返す（表示の陰影用）。 */
export function withNormals(polydata: Any): Any {
  try {
    const nrm: Any = vtkPolyDataNormals.newInstance();
    nrm.setInputData(polydata);
    nrm.setComputePointNormals(true);
    nrm.setComputeCellNormals(false);
    nrm.setSplitting(false);
    return nrm.getOutputData();
  } catch {
    return polydata;
  }
}

/** 三角形のみに整える（STL 出力/ボクセル化前）。 */
export function triangulate(polydata: Any): Any {
  try {
    const tf: Any = vtkTriangleFilter.newInstance();
    tf.setInputData(polydata);
    return tf.getOutputData();
  } catch {
    return polydata;
  }
}

// ── STL / OBJ I/O ─────────────────────────────────────────────

/** STL（binary/ascii 自動判定）を読み込み polydata を返す。頂点は患者 LPS mm として扱う。 */
export function importStl(buffer: ArrayBuffer): Any | null {
  try {
    const reader: Any = vtkSTLReader.newInstance();
    reader.parseAsArrayBuffer(buffer);
    const pd = reader.getOutputData();
    return pd ? withNormals(pd) : null;
  } catch {
    return null;
  }
}

/** OBJ（テキスト）を読み込み polydata を返す（最初のオブジェクト）。 */
export function importObj(text: string): Any | null {
  try {
    const reader: Any = vtkOBJReader.newInstance();
    reader.parseAsText(text);
    const pd = reader.getOutputData(0) ?? reader.getOutputData();
    return pd ? withNormals(triangulate(pd)) : null;
  } catch {
    return null;
  }
}

/** polydata を binary STL の ArrayBuffer に書き出す（頂点は患者 LPS mm）。 */
export function exportStlBinary(polydata: Any): ArrayBuffer | null {
  try {
    const tri = triangulate(polydata);
    // binary が既定（FormatTypes.BINARY）。DataView を返す。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: Any = (vtkSTLWriter as any).writeSTL(tri);
    if (out && out.buffer instanceof ArrayBuffer) return out.buffer as ArrayBuffer;
    if (out instanceof ArrayBuffer) return out;
    return null;
  } catch {
    return null;
  }
}
