/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * メッシュ修復・検証（`fw/3d-viewer-design.md` §8.4, §15 #7）。旧 GRAPHY
 * `MeshRepairer`/`MeshValidator` の TS 移植。vtk.js 同梱版に `vtkCleanPolyData`/`vtkFeatureEdges` が
 * 無いため**自前 real-space 実装**で代替する（`mesh3d.ts` は編集せず `getMeshArrays` を read）。
 *
 * - **検証（`validateMesh`）**: 重複頂点（座標一致）・退化三角形（面積 0/index 重複）・重複三角形・
 *   境界エッジ（1 三角形のみ＝穴/開口）・非多様体エッジ（3 三角形以上共有）・非参照頂点を診断。
 *   閉曲面（boundaryEdges=0）/多様体（nonManifoldEdges=0）判定を返す。
 * - **修復（`repairMesh`）**: 頂点溶接（tol 格子）→ 退化/重複三角形除去 → 非参照頂点圧縮 → 法線再計算。
 *   winding（面の向き）は元の頂点順を保持。新しい `vtkPolyData`（頂点は患者 LPS mm）を返す。
 *
 * 全て患者 LPS mm。表示≠確定計算の二層（設計 §3.2）に沿い、修復結果は新規メッシュとして扱う。
 */
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import { getMeshArrays, withNormals } from "./mesh3d";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** メッシュ検証レポート。 */
export interface MeshValidation {
  numPoints: number;
  numTriangles: number;
  /** 座標が一致し溶接可能な頂点の総数（= numPoints − ユニーク頂点数）。 */
  weldableVertices: number;
  /** 座標一致で 2 頂点以上が重なるグループ数。 */
  duplicateVertexGroups: number;
  /** 退化三角形（index 重複 or 面積ほぼ 0）の数。 */
  degenerateTriangles: number;
  /** 同一頂点集合の重複三角形の数（余剰分）。 */
  duplicateTriangles: number;
  /** 境界エッジ（1 三角形のみが使用＝穴/開口）の数。 */
  boundaryEdges: number;
  /** 非多様体エッジ（3 三角形以上が共有）の数。 */
  nonManifoldEdges: number;
  /** どの三角形にも使われない頂点の数。 */
  unreferencedVertices: number;
  /** 閉曲面か（境界エッジ 0）。 */
  isClosed: boolean;
  /** 多様体か（非多様体エッジ 0）。 */
  isManifold: boolean;
}

/** 修復オプション。 */
export interface RepairOptions {
  /** 頂点溶接の許容距離（mm）。既定は bbox 対角の 1e-6（最低 1e-4）。 */
  weldToleranceMm?: number;
}

/** 修復結果。 */
export interface RepairResult {
  polydata: Any;
  before: MeshValidation;
  after: MeshValidation;
  removedVertices: number;
  removedTriangles: number;
}

const edgeKey = (a: number, b: number): number => (a < b ? a * 0x4000000 + b : b * 0x4000000 + a);

/** 頂点溶接マップ（tol 格子で量子化）。代表座標も返す。 */
function weld(points: Float64Array, tol: number): { remap: Int32Array; reps: number[]; uniqueCount: number } {
  const inv = 1 / Math.max(tol, 1e-9);
  const map = new Map<string, number>();
  const n = points.length / 3;
  const remap = new Int32Array(n);
  const reps: number[] = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
    const key = `${Math.round(x * inv)}_${Math.round(y * inv)}_${Math.round(z * inv)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = next++;
      map.set(key, idx);
      reps.push(x, y, z); // 最初に出現した座標を代表に
    }
    remap[i] = idx;
  }
  return { remap, reps, uniqueCount: next };
}

/** bbox 対角から既定溶接許容距離を決める。 */
function defaultTolerance(points: Float64Array): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let p = 0; p < points.length; p += 3) {
    const x = points[p], y = points[p + 1], z = points[p + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return 1e-4;
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  return Math.max(1e-4, diag * 1e-6);
}

/** 溶接後の頂点/三角形からエッジ・境界・非多様体を集計する共通処理。 */
function analyzeTopology(
  points: Float64Array,
  tris: Uint32Array,
  remap: Int32Array,
  uniqueCount: number,
): {
  degenerate: number;
  duplicateTri: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  unreferenced: number;
} {
  const edgeCount = new Map<number, number>();
  const triSet = new Set<string>();
  const referenced = new Uint8Array(uniqueCount);
  let degenerate = 0;
  let duplicateTri = 0;

  for (let t = 0; t < tris.length; t += 3) {
    const a = remap[tris[t]], b = remap[tris[t + 1]], c = remap[tris[t + 2]];
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    // 面積ほぼ 0（同一直線）も退化扱い。
    const a3 = tris[t] * 3, b3 = tris[t + 1] * 3, c3 = tris[t + 2] * 3;
    const e1x = points[b3] - points[a3], e1y = points[b3 + 1] - points[a3 + 1], e1z = points[b3 + 2] - points[a3 + 2];
    const e2x = points[c3] - points[a3], e2y = points[c3 + 1] - points[a3 + 1], e2z = points[c3 + 2] - points[a3 + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (Math.hypot(nx, ny, nz) < 1e-12) {
      degenerate++;
      continue;
    }
    const sorted = [a, b, c].sort((p, q) => p - q);
    const tk = `${sorted[0]}_${sorted[1]}_${sorted[2]}`;
    if (triSet.has(tk)) {
      duplicateTri++;
      continue; // 重複面はエッジ集計に含めない
    }
    triSet.add(tk);
    referenced[a] = referenced[b] = referenced[c] = 1;
    for (const [u, w] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const k = edgeKey(u, w);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }

  let boundaryEdges = 0, nonManifoldEdges = 0;
  for (const cnt of edgeCount.values()) {
    if (cnt === 1) boundaryEdges++;
    else if (cnt > 2) nonManifoldEdges++;
  }
  let unreferenced = 0;
  for (let i = 0; i < uniqueCount; i++) if (!referenced[i]) unreferenced++;

  return { degenerate, duplicateTri, boundaryEdges, nonManifoldEdges, unreferenced };
}

/** メッシュを検証（トポロジ診断）。 */
export function validateMesh(polydata: Any, weldToleranceMm?: number): MeshValidation {
  const { points, tris } = getMeshArrays(polydata);
  const n = points.length / 3;
  const nt = tris.length / 3;
  const tol = weldToleranceMm ?? defaultTolerance(points);
  const { remap, uniqueCount } = weld(points, tol);
  // 溶接グループ（>1 頂点）数。
  const groupSize = new Int32Array(uniqueCount);
  for (let i = 0; i < n; i++) groupSize[remap[i]]++;
  let duplicateVertexGroups = 0;
  for (let g = 0; g < uniqueCount; g++) if (groupSize[g] > 1) duplicateVertexGroups++;

  const topo = analyzeTopology(points, tris, remap, uniqueCount);
  return {
    numPoints: n,
    numTriangles: nt,
    weldableVertices: n - uniqueCount,
    duplicateVertexGroups,
    degenerateTriangles: topo.degenerate,
    duplicateTriangles: topo.duplicateTri,
    boundaryEdges: topo.boundaryEdges,
    nonManifoldEdges: topo.nonManifoldEdges,
    unreferencedVertices: topo.unreferenced,
    isClosed: topo.boundaryEdges === 0,
    isManifold: topo.nonManifoldEdges === 0,
  };
}

/**
 * メッシュを修復（頂点溶接・退化/重複三角形除去・非参照頂点圧縮・法線再計算）して新しい polydata を返す。
 * winding は元の頂点順（a,b,c）を保持する。
 */
export function repairMesh(polydata: Any, opts: RepairOptions = {}): RepairResult {
  const { points, tris } = getMeshArrays(polydata);
  const tol = opts.weldToleranceMm ?? defaultTolerance(points);
  const before = validateMesh(polydata, tol);

  const { remap, reps, uniqueCount } = weld(points, tol);

  // 有効三角形（退化/重複除去）を溶接後 index で収集。winding は元順を維持。
  const triSet = new Set<string>();
  const keptTris: [number, number, number][] = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = remap[tris[t]], b = remap[tris[t + 1]], c = remap[tris[t + 2]];
    if (a === b || b === c || a === c) continue;
    const a3 = tris[t] * 3, b3 = tris[t + 1] * 3, c3 = tris[t + 2] * 3;
    const e1x = points[b3] - points[a3], e1y = points[b3 + 1] - points[a3 + 1], e1z = points[b3 + 2] - points[a3 + 2];
    const e2x = points[c3] - points[a3], e2y = points[c3 + 1] - points[a3 + 1], e2z = points[c3 + 2] - points[a3 + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (Math.hypot(nx, ny, nz) < 1e-12) continue;
    const sorted = [a, b, c].slice().sort((p, q) => p - q);
    const tk = `${sorted[0]}_${sorted[1]}_${sorted[2]}`;
    if (triSet.has(tk)) continue;
    triSet.add(tk);
    keptTris.push([a, b, c]);
  }

  // 非参照頂点圧縮（使われた溶接後 index のみ再採番）。
  const used = new Int32Array(uniqueCount).fill(-1);
  const outPoints: number[] = [];
  let outCount = 0;
  const mapUsed = (idx: number): number => {
    if (used[idx] === -1) {
      used[idx] = outCount++;
      outPoints.push(reps[idx * 3], reps[idx * 3 + 1], reps[idx * 3 + 2]);
    }
    return used[idx];
  };
  const polys = new Uint32Array(keptTris.length * 4);
  for (let i = 0; i < keptTris.length; i++) {
    const [a, b, c] = keptTris[i];
    polys[i * 4] = 3;
    polys[i * 4 + 1] = mapUsed(a);
    polys[i * 4 + 2] = mapUsed(b);
    polys[i * 4 + 3] = mapUsed(c);
  }

  const pd: Any = vtkPolyData.newInstance();
  pd.getPoints().setData(Float32Array.from(outPoints), 3);
  pd.getPolys().setData(polys);
  const out = withNormals(pd);

  const after = validateMesh(out, tol);
  return {
    polydata: out,
    before,
    after,
    removedVertices: before.numPoints - after.numPoints,
    removedTriangles: before.numTriangles - after.numTriangles,
  };
}
