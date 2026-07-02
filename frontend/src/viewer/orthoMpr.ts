/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Slicer 3 面（AX/COR/SAG）を **cornerstone のカメラに一切依存せず** world(LPS mm) 座標だけで
 * 自前リスライス描画するための純関数群。旧 GRAPHY の Slicer MPR と同じ方式。
 *
 * 設計要点:
 * - 各面は患者軸（±X/±Y/±Z）の直交平面。表示スライスは **常にスラブ中心 `center` の深さ**を通す
 *   （面法線方向成分 = dot(center, normal)）。これで「AX で置いた中心」を COR/SAG も同じ深さで表示し、
 *   3 面のオーバーレイ中心が**原理的に必ず一致**する。
 * - 面内フレーミングはボリューム bbox に固定（`center` では動かない）。中心はその中で移動する。
 * - world→パネル画素／画素→world は単純な線形写像（rowDir/colDir/normal は正規直交基底）。
 *   画像もオーバーレイも同一写像で描くのでズレようがない。
 *
 * 値のサンプルは `reslice.ts` の {@link makeWorldSampler}（world→トリリニア）を共有する。
 */
import type { ResliceVolume, Vec3, Interpolation } from "./reslice";
import { makeWorldSampler } from "./reslice";

// ── ベクトル小道具 ────────────────────────────────────────────
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

export type OrthoAxis = "axial" | "coronal" | "sagittal";
export const ORTHO_AXES: OrthoAxis[] = ["axial", "coronal", "sagittal"];

/** 各面の患者座標フレーム（rowDir=画面右, colDir=画面下, normal=rowDir×colDir 右手系）。 */
interface OrthoFrame {
  rowDir: Vec3;
  colDir: Vec3;
  normal: Vec3;
}
const FRAMES: Record<OrthoAxis, OrthoFrame> = {
  // 軸位: 右=+X(左手側), 下=+Y(後方), 法線=+Z(頭側)
  axial: { rowDir: [1, 0, 0], colDir: [0, 1, 0], normal: [0, 0, 1] },
  // 冠状: 右=+X(左手側), 下=−Z(足側), 法線=+Y(後方)
  coronal: { rowDir: [1, 0, 0], colDir: [0, 0, -1], normal: [0, 1, 0] },
  // 矢状: 右=+Y(後方), 下=−Z(足側), 法線=−X
  sagittal: { rowDir: [0, 1, 0], colDir: [0, 0, -1], normal: [-1, 0, 0] },
};

/** パネルの固定フレーミング（ボリューム bbox に基づく。center では不変）。 */
export interface PanelLayout {
  axis: OrthoAxis;
  rowDir: Vec3;
  colDir: Vec3;
  normal: Vec3;
  /** 画素(0,0) に対応する rowDir/colDir 方向の world 座標（mm）。 */
  uMin: number;
  vMin: number;
  /** スライス画像サイズ（画素）。 */
  widthPx: number;
  heightPx: number;
  /** 1 画素の mm（等方）。 */
  pxSpacing: number;
}

/** ボリューム 8 隅の world 座標。 */
function volumeCorners(vol: ResliceVolume): Vec3[] {
  const [W, H, D] = vol.dimensions;
  const [sx, sy, sz] = vol.spacing;
  const d = vol.direction;
  const dirI: Vec3 = [d[0], d[1], d[2]];
  const dirJ: Vec3 = [d[3], d[4], d[5]];
  const dirK: Vec3 = [d[6], d[7], d[8]];
  const o = vol.origin;
  const out: Vec3[] = [];
  for (const i of [0, W - 1]) {
    for (const j of [0, H - 1]) {
      for (const k of [0, D - 1]) {
        out.push([
          o[0] + dirI[0] * i * sx + dirJ[0] * j * sy + dirK[0] * k * sz,
          o[1] + dirI[1] * i * sx + dirJ[1] * j * sy + dirK[1] * k * sz,
          o[2] + dirI[2] * i * sx + dirJ[2] * j * sy + dirK[2] * k * sz,
        ]);
      }
    }
  }
  return out;
}

/** パネルのフレーミングを計算（bbox を rowDir/colDir へ射影して被覆）。pxSpacing 既定 = 最小 voxel 間隔。 */
export function computePanelLayout(vol: ResliceVolume, axis: OrthoAxis, pxSpacing?: number): PanelLayout {
  const f = FRAMES[axis];
  const px = pxSpacing && pxSpacing > 0 ? pxSpacing : Math.max(0.05, Math.min(vol.spacing[0], vol.spacing[1], vol.spacing[2]));
  const corners = volumeCorners(vol);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const c of corners) {
    const u = dot(c, f.rowDir);
    const v = dot(c, f.colDir);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const widthPx = Math.max(1, Math.round((uMax - uMin) / px) + 1);
  const heightPx = Math.max(1, Math.round((vMax - vMin) / px) + 1);
  return { axis, rowDir: f.rowDir, colDir: f.colDir, normal: f.normal, uMin, vMin, widthPx, heightPx, pxSpacing: px };
}

/** パネル画素(px,py) → world（面はスライス中心 center の深さを通る）。 */
export function panelPixelToWorld(layout: PanelLayout, center: Vec3, px: number, py: number): Vec3 {
  const u = layout.uMin + px * layout.pxSpacing;
  const v = layout.vMin + py * layout.pxSpacing;
  const depth = dot(center, layout.normal);
  return add(add(scale(layout.rowDir, u), scale(layout.colDir, v)), scale(layout.normal, depth));
}

/** world → パネル画素（連続値。深さ成分は捨象＝面へ正射影）。 */
export function worldToPanelPixel(layout: PanelLayout, w: Vec3): [number, number] {
  const u = dot(w, layout.rowDir);
  const v = dot(w, layout.colDir);
  return [(u - layout.uMin) / layout.pxSpacing, (v - layout.vMin) / layout.pxSpacing];
}

/** スライス画像（RGBA, 長さ = widthPx*heightPx*4）。center の深さの断面を W/L でグレースケール化。 */
export function renderPanelSlice(
  vol: ResliceVolume,
  layout: PanelLayout,
  center: Vec3,
  wl: { center: number; width: number },
  interpolation: Interpolation = "linear",
): Uint8ClampedArray {
  const sample = makeWorldSampler(vol, interpolation);
  const W = layout.widthPx;
  const H = layout.heightPx;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const lower = wl.center - wl.width / 2;
  const range = Math.max(1e-6, wl.width);
  const depth = dot(center, layout.normal);
  const { rowDir, colDir, normal, uMin, vMin, pxSpacing } = layout;
  // 深さ固定ベクトル（毎画素の normal*depth を先計算）。
  const dvec: Vec3 = scale(normal, depth);
  for (let py = 0; py < H; py++) {
    const v = vMin + py * pxSpacing;
    const cv: Vec3 = [dvec[0] + colDir[0] * v, dvec[1] + colDir[1] * v, dvec[2] + colDir[2] * v];
    let o = py * W * 4;
    for (let px = 0; px < W; px++) {
      const u = uMin + px * pxSpacing;
      const wx = cv[0] + rowDir[0] * u;
      const wy = cv[1] + rowDir[1] * u;
      const wz = cv[2] + rowDir[2] * u;
      let g = (sample([wx, wy, wz]) - lower) / range;
      g = g < 0 ? 0 : g > 1 ? 1 : g;
      const gi = (g * 255) | 0;
      rgba[o] = gi;
      rgba[o + 1] = gi;
      rgba[o + 2] = gi;
      rgba[o + 3] = 255;
      o += 4;
    }
  }
  return rgba;
}

// ── スラブオーバーレイ（箱を面で切断した交差ポリゴン＋ハンドル、パネル画素座標） ──

/** スラブ幾何（reslice の SlicerGeometry と同形）。 */
export interface SlabGeom {
  center: Vec3;
  normal: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
}
export interface SlabDims {
  numSlices: number;
  thickness: number;
  gap: number;
  fovWidth: number;
  fovHeight: number;
}
export type PanelPolygon = Array<[number, number]>;

/** 平面(点 p0・法線 n)で線分(a,b)を切断した交点。無ければ null。 */
function edgePlaneHit(a: Vec3, b: Vec3, p0: Vec3, n: Vec3): Vec3 | null {
  const da = dot(n, sub(a, p0));
  const db = dot(n, sub(b, p0));
  if ((da > 0 && db > 0) || (da < 0 && db < 0)) return null;
  const denom = da - db;
  if (Math.abs(denom) < 1e-9) return null;
  const t = da / denom;
  return add(a, scale(sub(b, a), t));
}

// 立方体 8 頂点（bit0=rowDir±, bit1=colDir±, bit2=normal±）の 1 ビット違い対を辺とする。
const BOX_EDGES: Array<[number, number]> = (() => {
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) {
    const j = i | bit;
    if (j !== i && j > i) edges.push([i, j]);
  }
  return edges;
})();

/**
 * 各スライス箱を「center の深さを通るパネル平面」で切断し、交差ポリゴン（パネル画素座標）を返す。
 * パネル平面は `slab.center` を通り法線 = `layout.normal`。
 */
export function computeSlabBandsPanel(layout: PanelLayout, geom: SlabGeom, slab: SlabDims): PanelPolygon[] {
  const out: PanelPolygon[] = [];
  const n = Math.max(1, Math.floor(slab.numSlices));
  const hr = scale(geom.rowDir, slab.fovWidth / 2);
  const hc = scale(geom.colDir, slab.fovHeight / 2);
  const step = slab.thickness + slab.gap;
  const Pv = geom.center; // パネル平面はスラブ中心を通る（＝表示スライス深さ）
  const Nv = layout.normal;
  for (let s = 0; s < n; s++) {
    const centerOff = (s - (n - 1) / 2) * step;
    const cp = add(geom.center, scale(geom.normal, centerOff));
    const hn = scale(geom.normal, slab.thickness / 2);
    const corners: Vec3[] = [];
    for (let i = 0; i < 8; i++) {
      const sr = i & 1 ? 1 : -1;
      const sc = i & 2 ? 1 : -1;
      const sn = i & 4 ? 1 : -1;
      corners.push(add(add(add(cp, scale(hr, sr)), scale(hc, sc)), scale(hn, sn)));
    }
    const pts: Vec3[] = [];
    for (const [i, j] of BOX_EDGES) {
      const hit = edgePlaneHit(corners[i], corners[j], Pv, Nv);
      if (hit) pts.push(hit);
    }
    if (pts.length < 3) {
      out.push([]);
      continue;
    }
    const cpts = pts.map((w) => worldToPanelPixel(layout, w));
    let cx = 0, cy = 0;
    for (const p of cpts) {
      cx += p[0];
      cy += p[1];
    }
    cx /= cpts.length;
    cy /= cpts.length;
    cpts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    const dedup: PanelPolygon = [];
    for (const p of cpts) {
      const last = dedup[dedup.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.25 / layout.pxSpacing) dedup.push(p);
    }
    out.push(dedup.length >= 3 ? dedup : []);
  }
  return out;
}

export interface SlabHandlesPanel {
  center: [number, number];
  corners: Array<[number, number]>; // FOV 矩形 4 隅（TL,TR,BR,BL）
}

/** スラブ中央スライス FOV 矩形の中心＋4 隅（パネル画素座標）。 */
export function computeSlabHandlesPanel(layout: PanelLayout, geom: SlabGeom, slab: SlabDims): SlabHandlesPanel {
  const hr = scale(geom.rowDir, slab.fovWidth / 2);
  const hc = scale(geom.colDir, slab.fovHeight / 2);
  const c = geom.center;
  const w2p = (w: Vec3) => worldToPanelPixel(layout, w);
  return {
    center: w2p(c),
    corners: [
      w2p(sub(sub(c, hr), hc)), // TL
      w2p(sub(add(c, hr), hc)), // TR
      w2p(add(add(c, hr), hc)), // BR
      w2p(add(sub(c, hr), hc)), // BL
    ],
  };
}

// ── 幾何操作（純関数; パネル画素座標での平行移動・回転、world↔voxel） ─────────────
const normalize = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
/** Rodrigues: 単位軸 k まわりに v を θ 回転。 */
const rotateAboutAxis = (v: Vec3, k: Vec3, theta: number): Vec3 => {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
};

/**
 * 対象パネル面内でスラブ中心を平行移動（パネル画素 last→now の world 差分を center に加算）。
 * last/now は同じ center 深さの面上に射影されるため、差分は面内成分のみ（深さは相殺）。
 */
export function translateGeomInPlanePanel(layout: PanelLayout, geom: SlabGeom, last: [number, number], now: [number, number]): SlabGeom {
  const wl = panelPixelToWorld(layout, geom.center, last[0], last[1]);
  const wn = panelPixelToWorld(layout, geom.center, now[0], now[1]);
  return { ...geom, center: add(geom.center, sub(wn, wl)) };
}

/** 対象パネル面の法線軸まわりにスラブを回転（center 不動、パネル画素 last→now の world 角度差）。 */
export function rotateGeomInPlanePanel(layout: PanelLayout, geom: SlabGeom, last: [number, number], now: [number, number]): SlabGeom {
  const axis = normalize(layout.normal);
  const a = normalize(sub(panelPixelToWorld(layout, geom.center, last[0], last[1]), geom.center));
  const b = normalize(sub(panelPixelToWorld(layout, geom.center, now[0], now[1]), geom.center));
  const theta = Math.atan2(dot(cross(a, b), axis), dot(a, b));
  if (!Number.isFinite(theta) || theta === 0) return geom;
  return {
    center: geom.center,
    normal: normalize(rotateAboutAxis(geom.normal, axis, theta)),
    rowDir: normalize(rotateAboutAxis(geom.rowDir, axis, theta)),
    colDir: normalize(rotateAboutAxis(geom.colDir, axis, theta)),
  };
}

/** world → ボクセル座標 IJK（連続値。direction 正規直交前提で内積により解く）。 */
export function worldToVoxel(vol: ResliceVolume, w: Vec3): Vec3 {
  const d = vol.direction;
  const p = sub(w, vol.origin);
  return [
    (p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) / vol.spacing[0],
    (p[0] * d[3] + p[1] * d[4] + p[2] * d[5]) / vol.spacing[1],
    (p[0] * d[6] + p[1] * d[7] + p[2] * d[8]) / vol.spacing[2],
  ];
}

/** ボクセル座標 IJK → world。 */
export function voxelToWorld(vol: ResliceVolume, ijk: Vec3): Vec3 {
  const d = vol.direction;
  const [sx, sy, sz] = vol.spacing;
  return [
    vol.origin[0] + d[0] * ijk[0] * sx + d[3] * ijk[1] * sy + d[6] * ijk[2] * sz,
    vol.origin[1] + d[1] * ijk[0] * sx + d[4] * ijk[1] * sy + d[7] * ijk[2] * sz,
    vol.origin[2] + d[2] * ijk[0] * sx + d[5] * ijk[1] * sy + d[8] * ijk[2] * sz,
  ];
}

/** ボリューム中心の world 座標（ボクセル ((W-1)/2, (H-1)/2, (D-1)/2)）。 */
export function volumeCenterWorld(vol: ResliceVolume): Vec3 {
  return voxelToWorld(vol, [(vol.dimensions[0] - 1) / 2, (vol.dimensions[1] - 1) / 2, (vol.dimensions[2] - 1) / 2]);
}
