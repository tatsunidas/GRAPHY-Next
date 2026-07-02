/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D 計測（ルーラー）の**幾何ユーティリティ**（`fw/3d-viewer-design.md` §15-#3）。
 * 旧 GRAPHY `view/D3/util/RayMeshIntersector` ＋ `Measurement3DLineCommands` の TS/vtk.js 移植。
 *
 * 画面クリックを **pure vtk のカメラ行列の逆**で world レイへ逆投影し（`makeUnprojector`）、シーンの
 * メッシュ/ROI 表面三角形に **Möller-Trumbore** で交差させて（`rayTriangleIntersect`）拾った点を求める。
 * 距離は拾った 2 点の真の mm。要件 11 に従い全て実空間 LPS mm で、cornerstone のピッカー/デバイスピクセルに依存しない。
 *
 * 逆投影は `makeCameraProjector`（`volumeCut.ts`）の順投影と対（合成行列 M=Pt·Vt を反転）。NDC z=-1(near)/+1(far)
 * を world へ戻して視線レイを作る。dpr は CSS 換算で相殺されるため、必要なのはカメラ＋CSS 寸法のみ。
 */

import { type VolumeGeom, voxelToWorld, worldToVoxel } from "../viewer/labelVolume";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type V3 = [number, number, number];

/** world 空間の視線レイ（origin=near 面, dir=正規化した奥行き方向）。 */
export interface Ray {
  origin: V3;
  dir: V3;
}

// ── 列優先（gl-matrix 互換, m[col*4+row]）4×4 行列ヘルパ ──────────
function transpose16(m: ArrayLike<number>): number[] {
  return [
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  ];
}

/** 列優先 a·b。 */
function mul16(a: number[], b: number[]): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** 列優先 4×4 逆行列（Mesa gluInvertMatrix）。非可逆なら null。 */
function invert16(m: number[]): number[] | null {
  const inv = new Array<number>(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!(Math.abs(det) > 1e-20)) return null;
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

/** 列優先 m で同次点 (x,y,z,1) を変換し、w 除算した [x,y,z]。w<=eps は null。 */
function unproject(m: number[], x: number, y: number, z: number): V3 | null {
  const ox = m[0] * x + m[4] * y + m[8] * z + m[12];
  const oy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const oz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const ow = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(Math.abs(ow) > 1e-12)) return null;
  return [ox / ow, oy / ow, oz / ow];
}

/**
 * 現在のカメラ状態から「CSS 座標 → world 視線レイ」の逆投影関数を作る。
 * `makeCameraProjector` の順投影と対（合成行列 M=Pt·Vt を反転）。取得不能なら null。
 */
export function makeUnprojector(
  renderer: Any,
  cssWidth: number,
  cssHeight: number,
): ((cssX: number, cssY: number) => Ray | null) | null {
  try {
    const cam: Any = renderer?.getActiveCamera?.();
    if (!cam || cssWidth <= 0 || cssHeight <= 0) return null;
    const aspect = cssWidth / cssHeight;
    const Vt = transpose16(cam.getViewMatrix());
    const Pt = transpose16(cam.getProjectionMatrix(aspect, -1, 1));
    const M = mul16(Pt, Vt); // world→NDC（順投影の合成）
    const Minv = invert16(M);
    if (!Minv) return null;
    return (cssX: number, cssY: number): Ray | null => {
      const ndcX = (cssX / cssWidth) * 2 - 1;
      const ndcY = 1 - (cssY / cssHeight) * 2;
      const near = unproject(Minv, ndcX, ndcY, -1);
      const far = unproject(Minv, ndcX, ndcY, 1);
      if (!near || !far) return null;
      const dx = far[0] - near[0], dy = far[1] - near[1], dz = far[2] - near[2];
      const n = Math.hypot(dx, dy, dz) || 1;
      return { origin: near, dir: [dx / n, dy / n, dz / n] };
    };
  } catch {
    return null;
  }
}

/**
 * 逆 view-projection 行列（NDC→world, 列優先 16 要素）を返す。GPU パストレーサ（`cinematicPathTracer.ts`）で
 * per-pixel の world レイを再構成するための uniform。`makeUnprojector` と同じ合成（M=Pt·Vt）を反転。取得不能なら null。
 */
export function inverseViewProj(renderer: Any, cssWidth: number, cssHeight: number): number[] | null {
  try {
    const cam: Any = renderer?.getActiveCamera?.();
    if (!cam || cssWidth <= 0 || cssHeight <= 0) return null;
    const aspect = cssWidth / cssHeight;
    const Vt = transpose16(cam.getViewMatrix());
    const Pt = transpose16(cam.getProjectionMatrix(aspect, -1, 1));
    return invert16(mul16(Pt, Vt));
  } catch {
    return null;
  }
}

/**
 * ボリューム表面ピック（メッシュ/ROI が無い表示モードでも計測できるようにするフォールバック）。
 * world レイをボクセル空間で march し、**現在の LUT/不透明度**（`lutRgba` の alpha）が閾値を超える最初の位置＝
 * 表示上の「表面」を拾って world 点を返す。VR の見た目と整合。ヒットなしは null。
 *
 * @param scalars  imageData の生スカラー（z-major, 長さ dims[0]*dims[1]*dims[2]）。
 * @param geom     ボリューム幾何（origin/spacing/direction/dims）。
 * @param dataRange スカラーの [min,max]（正規化用）。
 * @param lutRgba  256×4 RGBA（`VtkVolumeView.getLut256`＝W/L・LUT・不透明度カーブ焼き込み済）。
 */
export function pickVolumeSurface(
  ray: Ray,
  scalars: ArrayLike<number>,
  geom: VolumeGeom,
  dataRange: [number, number],
  lutRgba: Uint8Array,
  threshold = 0.15,
): V3 | null {
  const [nx, ny, nz] = geom.dims;
  const frame = nx * ny;
  if (!scalars || scalars.length < frame * nz) return null;
  const [dmin, dmax] = dataRange;
  const span = dmax - dmin || 1;

  // world レイ → ボクセル空間（連続 index）。o + d*t が index 空間の直線。
  const o = worldToVoxel(geom, ray.origin);
  const p1 = worldToVoxel(geom, [ray.origin[0] + ray.dir[0], ray.origin[1] + ray.dir[1], ray.origin[2] + ray.dir[2]]);
  const d: V3 = [p1[0] - o[0], p1[1] - o[1], p1[2] - o[2]]; // voxels / (1mm along dir)
  const dLen = Math.hypot(d[0], d[1], d[2]);
  if (dLen < 1e-9) return null;

  // ボクセルセンター [0,dims-1] を含む箱 [-0.5, dims-0.5] とのスラブ交差（t は上記直線パラメータ）。
  let tNear = -Infinity, tFar = Infinity;
  const lo = [-0.5, -0.5, -0.5];
  const hi = [nx - 0.5, ny - 0.5, nz - 0.5];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return null;
    } else {
      let t1 = (lo[a] - o[a]) / d[a];
      let t2 = (hi[a] - o[a]) / d[a];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tNear) tNear = t1;
      if (t2 < tFar) tFar = t2;
    }
  }
  if (tNear > tFar || tFar < 0) return null;
  const t0 = Math.max(tNear, 0);

  // 0.5 ボクセル刻みで march。
  const dt = 0.5 / dLen;
  const maxSteps = 4096;
  let t = t0;
  for (let s = 0; s < maxSteps && t <= tFar; s++, t += dt) {
    const vi = o[0] + d[0] * t;
    const vj = o[1] + d[1] * t;
    const vk = o[2] + d[2] * t;
    const i = Math.round(vi), j = Math.round(vj), k = Math.round(vk);
    if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) continue;
    const raw = scalars[k * frame + j * nx + i];
    let norm = (raw - dmin) / span;
    norm = norm < 0 ? 0 : norm > 1 ? 1 : norm;
    const alpha = lutRgba[(Math.round(norm * 255) | 0) * 4 + 3] / 255;
    if (alpha >= threshold) return voxelToWorld(geom, vi, vj, vk);
  }
  return null;
}

/**
 * レイと三角形 (v0,v1,v2) の交差（Möller-Trumbore）。
 * 交差すれば origin からの距離 t（>eps, dir 正規化なので mm）を返す。なければ null。
 */
export function rayTriangleIntersect(
  ray: Ray,
  v0: V3,
  v1: V3,
  v2: V3,
): number | null {
  const EPS = 1e-7;
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.dir;
  const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
  const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
  // p = dir × e2
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -EPS && det < EPS) return null; // 平行
  const invDet = 1 / det;
  const tx = ox - v0[0], ty = oy - v0[1], tz = oz - v0[2];
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < -EPS || u > 1 + EPS) return null;
  // q = t × e1
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < -EPS || u + v > 1 + EPS) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > EPS ? t : null;
}
