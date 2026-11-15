/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer の視点とクリップ面の指定（患者 LPS・mm の純関数）。DOM も vtk も使わない。
 *
 * - 画面右 = 視線 × 上（右手系。`cameraSnap.ts` の規約と同じ）。
 * - 視線は「カメラ → 注視点」の向き。`up` は視線に直交化して使う（平行なら拒否）。
 * - クリップ面は **法線の向く側を残す**（vtkPlane・`scene3d.computeClipPlanes` と同じ規約）。
 *
 * 不正な入力は理由つきで拒否する（黙って既定値に置き換えない）。
 */
import type { Vec3 } from "./slabGeometry";

/** vtk.js の VolumeMapper が持てるクリップ面の上限（シェーダの配列が 6）。 */
export const MAX_CLIP_PLANES = 6;

/** `up` が視線とこれ以上平行なら向きが決まらないので拒否する（|cos| の上限）。 */
const PARALLEL_COS = 1 - 1e-6;

export interface ViewRequest {
  /** 視線方向（カメラ → 注視点）。長さは問わない（0・非有限は拒否）。 */
  direction: Vec3;
  /** 画面の上。視線に直交でなくてよい（直交化して返す）。視線と平行なら拒否。 */
  up: Vec3;
  /** 注視点（LPS mm）。 */
  focalPoint: Vec3;
  /** カメラから注視点までの距離（mm、> 0）。 */
  distanceMm: number;
}

export interface ViewCamera {
  position: Vec3;
  focalPoint: Vec3;
  /** 視線に直交する単位ベクトル。 */
  viewUp: Vec3;
  /** 画面右（視線 × 上）。 */
  right: Vec3;
  /** 正規化した視線。 */
  direction: Vec3;
}

export type ViewResult = ({ ok: true } & ViewCamera) | { ok: false; reason: string };

const finite = (v: readonly number[]): boolean => v.every((x) => Number.isFinite(x));
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** 視線・上・注視点・距離から、カメラの位置と直交した上・画面右を求める。 */
export function cameraFromView(req: ViewRequest): ViewResult {
  const { direction, up, focalPoint, distanceMm } = req;
  if (!finite(direction) || norm(direction) === 0) return { ok: false, reason: "視線方向が 0 か非有限です" };
  if (!finite(up) || norm(up) === 0) return { ok: false, reason: "上方向が 0 か非有限です" };
  if (!finite(focalPoint)) return { ok: false, reason: "注視点が非有限です" };
  if (!(Number.isFinite(distanceMm) && distanceMm > 0)) return { ok: false, reason: "距離は正の有限値が必要です" };
  const d = unit(direction);
  const u0 = unit(up);
  if (Math.abs(dot(d, u0)) > PARALLEL_COS) return { ok: false, reason: "上方向が視線と平行です（向きが決まりません）" };
  // Gram–Schmidt: 視線に直交する成分だけを残す。
  const k = dot(u0, d);
  const viewUp = unit([u0[0] - k * d[0], u0[1] - k * d[1], u0[2] - k * d[2]]);
  const right = cross(d, viewUp);
  const position: Vec3 = [
    focalPoint[0] - distanceMm * d[0],
    focalPoint[1] - distanceMm * d[1],
    focalPoint[2] - distanceMm * d[2],
  ];
  return { ok: true, position, focalPoint: [...focalPoint], viewUp, right, direction: d };
}

export interface ClipPlaneInput {
  /** 面上の 1 点（LPS mm）。 */
  origin: Vec3;
  /** 法線。**向く側を残す**。長さは問わない（0・非有限は拒否）。 */
  normal: Vec3;
}

export type ClipPlanesResult =
  | { ok: true; planes: { origin: Vec3; normal: Vec3 }[] }
  | { ok: false; reason: string };

/** クリップ面を検証し、法線を正規化して返す。 */
export function validateClipPlanes(planes: readonly ClipPlaneInput[]): ClipPlanesResult {
  if (planes.length > MAX_CLIP_PLANES) return { ok: false, reason: `クリップ面は ${MAX_CLIP_PLANES} 枚までです（${planes.length} 枚）` };
  const out: { origin: Vec3; normal: Vec3 }[] = [];
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    if (!finite(p.origin)) return { ok: false, reason: `クリップ面 ${i}: 原点が非有限です` };
    if (!finite(p.normal) || norm(p.normal) === 0) return { ok: false, reason: `クリップ面 ${i}: 法線が 0 か非有限です` };
    out.push({ origin: [...p.origin], normal: unit(p.normal) });
  }
  return { ok: true, planes: out };
}
