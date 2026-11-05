/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * MPR の 3D ROI（患者座標 LPS・mm、軸平行の直方体／楕円体）の純ロジック。Cornerstone に触れない。
 *
 * <p>ROI は中心（mm）と 3 軸の**全長**（mm）だけで決まる。ピクセルやスライス番号は持たない
 * （描画との変換は `mpr/Roi3dOverlay.tsx` の薄い層に閉じる）。軸は X=0（患者の左）, Y=1（後）, Z=2（頭）。
 *
 * <p>容積は解析式: 直方体 `Lx·Ly·Lz`、楕円体 `π·Lx·Ly·Lz/6`（全長 L から。半軸 a=L/2 なら 4/3·π·a·b·c）。
 * 1 mL = 1000 mm³。ボクセルを数えた値ではない（境界のボクセルぶんの差は段 2 の数え上げで見る）。
 */

export type Roi3dShape = "box" | "ellipsoid";
export type Axis3 = 0 | 1 | 2;
export type PlaneId = "axial" | "coronal" | "sagittal";
export type Vec3 = [number, number, number];

export interface Roi3dBox {
  id: string;
  shape: Roi3dShape;
  /** 中心（mm, LPS）。 */
  center: Vec3;
  /** X, Y, Z の全長（mm）。常に有限で正。 */
  size: Vec3;
}

/** 各断面の法線軸と、画面の横(u)・縦(v)に当たる世界軸（`viewer/orthoMpr.ts` のフレームと同じ対応）。 */
export const PLANE_AXES: Record<PlaneId, { normal: Axis3; u: Axis3; v: Axis3 }> = {
  axial: { normal: 2, u: 0, v: 1 },
  coronal: { normal: 1, u: 0, v: 2 },
  sagittal: { normal: 0, u: 1, v: 2 },
};

export const AXIS_NAMES = ["X", "Y", "Z"] as const;

export function volumeMm3(b: Pick<Roi3dBox, "shape" | "size">): number {
  const p = b.size[0] * b.size[1] * b.size[2];
  return b.shape === "box" ? p : (Math.PI * p) / 6;
}

export function volumeMl(b: Pick<Roi3dBox, "shape" | "size">): number {
  return volumeMm3(b) / 1000;
}

/** 容積の表示（mL, 有効数字 5 桁。例 1.0472 / 1.0000）。 */
export function formatMl(ml: number): string {
  return ml.toPrecision(5);
}

/** 数値を代入した式の文字列（ダイアログの展開行に出す）。 */
export function formulaText(b: Pick<Roi3dBox, "shape" | "size">): string {
  const [x, y, z] = b.size.map((v) => v.toFixed(1));
  const body = b.shape === "box" ? `${x} × ${y} × ${z}` : `π × ${x} × ${y} × ${z} / 6`;
  const sym = b.shape === "box" ? "Lx × Ly × Lz" : "π × Lx × Ly × Lz / 6";
  return `V = ${sym} = ${body} = ${volumeMm3(b).toFixed(1)} mm³ = ${formatMl(volumeMl(b))} mL`;
}

export interface Roi3dSection {
  shape: Roi3dShape;
  /** 断面の中心（u, v 軸の mm）。 */
  cu: number;
  cv: number;
  /** 断面の半幅（u, v 方向, mm）。 */
  hu: number;
  hv: number;
}

/** 法線軸上の位置 `planePos`（mm）での断面。ROI がその位置に届かなければ null。 */
export function sectionAt(b: Roi3dBox, plane: PlaneId, planePos: number): Roi3dSection | null {
  const { normal, u, v } = PLANE_AXES[plane];
  const half = b.size[normal] / 2;
  const d = planePos - b.center[normal];
  if (Math.abs(d) > half) return null;
  const k = b.shape === "box" ? 1 : Math.sqrt(1 - (d * d) / (half * half));
  return { shape: b.shape, cu: b.center[u], cv: b.center[v], hu: (b.size[u] / 2) * k, hv: (b.size[v] / 2) * k };
}

/**
 * ある断面上の対角 2 点（u, v 軸の mm）から ROI を作る。
 * 第 3 軸（法線方向）の全長は面内 2 径の短い方、中心は `planePos`（描いた断面の位置）。
 * 面内の径が 0 以下なら null。
 */
export function boxFromDiagonal(
  id: string,
  shape: Roi3dShape,
  plane: PlaneId,
  planePos: number,
  p0: [number, number],
  p1: [number, number],
): Roi3dBox | null {
  const { normal, u, v } = PLANE_AXES[plane];
  const lu = Math.abs(p1[0] - p0[0]);
  const lv = Math.abs(p1[1] - p0[1]);
  if (!(lu > 0) || !(lv > 0)) return null;
  const center: Vec3 = [0, 0, 0];
  const size: Vec3 = [0, 0, 0];
  center[u] = (p0[0] + p1[0]) / 2;
  center[v] = (p0[1] + p1[1]) / 2;
  center[normal] = planePos;
  size[u] = lu;
  size[v] = lv;
  size[normal] = Math.min(lu, lv);
  return { id, shape, center, size };
}

/** 1 軸の全長を変える（中心は保つ）。正の有限値でなければ変更しない。 */
export function withSize(b: Roi3dBox, axis: Axis3, length: number): Roi3dBox {
  if (!Number.isFinite(length) || !(length > 0)) return b;
  const size = [...b.size] as Vec3;
  size[axis] = length;
  return { ...b, size };
}

/** 1 軸の中心を変える。 */
export function withCenter(b: Roi3dBox, axis: Axis3, pos: number): Roi3dBox {
  if (!Number.isFinite(pos)) return b;
  const center = [...b.center] as Vec3;
  center[axis] = pos;
  return { ...b, center };
}

/**
 * 1 軸の片側の端（side=-1 小さい側 / +1 大きい側）を `pos` へ動かす。反対側の端は固定。
 * 反対側を越える（長さが 0 以下になる）ときは変更しない。
 */
export function resizeEdge(b: Roi3dBox, axis: Axis3, side: -1 | 1, pos: number): Roi3dBox {
  const half = b.size[axis] / 2;
  const lo = side === -1 ? pos : b.center[axis] - half;
  const hi = side === 1 ? pos : b.center[axis] + half;
  if (!Number.isFinite(pos) || !(hi - lo > 0)) return b;
  const size = [...b.size] as Vec3;
  const center = [...b.center] as Vec3;
  size[axis] = hi - lo;
  center[axis] = (hi + lo) / 2;
  return { ...b, size, center };
}

export function translate(b: Roi3dBox, delta: Vec3): Roi3dBox {
  return { ...b, center: [b.center[0] + delta[0], b.center[1] + delta[1], b.center[2] + delta[2]] };
}

/** 世界座標のボリューム境界（vtk の getBounds と同じ並び）。 */
export type Bounds6 = [number, number, number, number, number, number];

/** ROI の外接直方体がボリュームの外へ出るか。楕円体も外接直方体で見る（保守的）。 */
export function outOfBounds(b: Roi3dBox, bounds: Bounds6): boolean {
  for (let a = 0; a < 3; a++) {
    const half = b.size[a] / 2;
    if (b.center[a] - half < bounds[a * 2] || b.center[a] + half > bounds[a * 2 + 1]) return true;
  }
  return false;
}
