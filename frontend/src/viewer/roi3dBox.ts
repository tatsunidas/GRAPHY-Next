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
  /** 台帳のメタ（保存される）。 */
  label?: string;
  color?: string;
  visible?: boolean;
  locked?: boolean;
  /** どのシリーズの上に描いたか（このシリーズを開いたときに復元する）。 */
  studyUid?: string;
  seriesUid?: string;
  /** 最後に編集した時刻（ISO-8601）。窓をまたぐ保存の競合で新しい方を採る鍵。 */
  updatedAt?: string;
  /** 次元 scope（チャンネル c／時相 t）。未指定は全て。2D のスライス表示の絞り込みに使う。 */
  c?: DimIndex;
  t?: DimIndex;
  /** マスクへ焼き込むときの積み先（スタック）を引くための、作成スライスの imageId。 */
  refImageId?: string;
  seriesLabel?: string;
  /** 2D 窓で複数患者を同時に開くときの絞り込み用（保存先は患者単位なので、無くても復元はできる）。 */
  patientKey?: string;
}

/** 次元 scope の値: 0 以上の整数、または全て。 */
export type DimIndex = number | "all";

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

const isDimIndex = (v: unknown): v is DimIndex => v === "all" || (typeof v === "number" && Number.isInteger(v) && v >= 0);

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/**
 * 保存されていた solid を読む。壊れた要素（形が未知・中心が欠ける・径が 0 以下や非有限）は null にして
 * 呼び出し側が**その 1 件だけ**落とせるようにする（1 件の破損で他を失わない）。
 */
export function sanitizeSolid(v: unknown): Roi3dBox | null {
  const s = v as Partial<Roi3dBox> | null;
  if (!s || typeof s.id !== "string" || !s.id) return null;
  if (s.shape !== "box" && s.shape !== "ellipsoid") return null;
  if (!isVec3(s.center) || !isVec3(s.size) || !s.size.every((x) => x > 0)) return null;
  const out: Roi3dBox = { id: s.id, shape: s.shape, center: [...s.center], size: [...s.size] };
  if (typeof s.label === "string") out.label = s.label;
  if (typeof s.color === "string") out.color = s.color;
  if (typeof s.visible === "boolean") out.visible = s.visible;
  if (typeof s.locked === "boolean") out.locked = s.locked;
  if (typeof s.studyUid === "string") out.studyUid = s.studyUid;
  if (typeof s.seriesUid === "string") out.seriesUid = s.seriesUid;
  if (typeof s.updatedAt === "string") out.updatedAt = s.updatedAt;
  if (isDimIndex(s.c)) out.c = s.c;
  if (isDimIndex(s.t)) out.t = s.t;
  if (typeof s.refImageId === "string") out.refImageId = s.refImageId;
  if (typeof s.seriesLabel === "string") out.seriesLabel = s.seriesLabel;
  if (typeof s.patientKey === "string") out.patientKey = s.patientKey;
  return out;
}

/**
 * 保存の競合で solid を混ぜる。id で和を取り、**同じ id は `updatedAt` の新しい方**を採る
 * （ローカル優先にすると、古い窓の保存が別の窓の新しい編集を潰す）。同時刻・未記録ならローカル。
 * 墓標に載った id は除く。順序は id で決定的。
 */
export function mergeSolids(remote: Roi3dBox[], local: Roi3dBox[], buried: Set<string>): Roi3dBox[] {
  const byId = new Map<string, Roi3dBox>();
  for (const r of remote) byId.set(r.id, r);
  for (const l of local) {
    const r = byId.get(l.id);
    byId.set(l.id, r && (r.updatedAt ?? "") > (l.updatedAt ?? "") ? r : l);
  }
  for (const id of buried) byId.delete(id);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 3 軸の全長が等しい（球）なら半径、そうでなければ null。楕円体のみ。 */
export function solidRadius(b: Pick<Roi3dBox, "shape" | "size">): number | null {
  if (b.shape !== "ellipsoid") return null;
  const [x, y, z] = b.size;
  const tol = 1e-9 * Math.max(x, y, z);
  return Math.abs(x - y) <= tol && Math.abs(y - z) <= tol ? x / 2 : null;
}

/** 中心と半径（mm）から球（3 軸が等しい楕円体）の形を作る。 */
export function sphereSolid(id: string, center: Vec3, radiusMm: number): Roi3dBox {
  const d = radiusMm * 2;
  return { id, shape: "ellipsoid", center: [...center], size: [d, d, d] };
}

/** 世界座標の点が ROI の内側（境界を含む）か。楕円体は `Σ((p−c)/半軸)²≤1`、直方体は各軸 `|p−c|≤L/2`。 */
export function containsPoint(b: Pick<Roi3dBox, "shape" | "center" | "size">, p: Vec3): boolean {
  if (b.shape === "box") {
    return [0, 1, 2].every((i) => Math.abs(p[i] - b.center[i]) <= b.size[i] / 2);
  }
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const q = (p[i] - b.center[i]) / (b.size[i] / 2);
    sum += q * q;
  }
  return sum <= 1;
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 楕円体と平面の断面（楕円）。中心と、2 本の主軸（単位方向・半長, mm）。 */
export interface EllipseSection {
  center: Vec3;
  axes: [{ dir: Vec3; half: number }, { dir: Vec3; half: number }];
}

/**
 * 軸平行の楕円体と、点 `origin` を通り面内の単位基底 `u`, `v`（直交）で張られる平面との断面。
 * 面内の点 `p=origin+a·u+b·v` を楕円体の式に入れた 2 次形式 `[a b]M[a b]ᵀ + 2g·[a b] + k ≤ 1` を解く。
 * 球の断面が円（半径 √(r²−d²)）になるのは、その特別な場合。交わらない（接する）ときは null。
 */
export function ellipsoidSection(b: Pick<Roi3dBox, "center" | "size">, origin: Vec3, u: Vec3, v: Vec3): EllipseSection | null {
  const iw = b.size.map((l) => 4 / (l * l)); // 1/半軸²
  const w: Vec3 = [origin[0] - b.center[0], origin[1] - b.center[1], origin[2] - b.center[2]];
  const q = (x: Vec3, y: Vec3): number => x[0] * y[0] * iw[0] + x[1] * y[1] * iw[1] + x[2] * y[2] * iw[2];
  const m11 = q(u, u);
  const m12 = q(u, v);
  const m22 = q(v, v);
  const g1 = q(w, u);
  const g2 = q(w, v);
  const det = m11 * m22 - m12 * m12;
  if (!(det > 0)) return null;
  // 中心 s = −M⁻¹g、そこでの F の最小値 k0 = k − gᵀM⁻¹g
  const s1 = -(m22 * g1 - m12 * g2) / det;
  const s2 = -(-m12 * g1 + m11 * g2) / det;
  const k0 = q(w, w) + g1 * s1 + g2 * s2;
  const rest = 1 - k0;
  if (!(rest > 0)) return null;
  // M の固有分解（2×2 対称）。主軸の半長は √(rest/λ)。
  const tr = m11 + m22;
  const disc = Math.sqrt(Math.max(0, ((m11 - m22) / 2) ** 2 + m12 * m12));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  const theta = 0.5 * Math.atan2(2 * m12, m11 - m22); // l1 に属する固有ベクトルの角度
  const e1: [number, number] = [Math.cos(theta), Math.sin(theta)];
  const e2: [number, number] = [-Math.sin(theta), Math.cos(theta)];
  const world = (e: [number, number]): Vec3 => [
    e[0] * u[0] + e[1] * v[0],
    e[0] * u[1] + e[1] * v[1],
    e[0] * u[2] + e[1] * v[2],
  ];
  return {
    center: [origin[0] + s1 * u[0] + s2 * v[0], origin[1] + s1 * u[1] + s2 * v[1], origin[2] + s1 * u[2] + s2 * v[2]],
    axes: [
      { dir: world(e1), half: Math.sqrt(rest / l1) },
      { dir: world(e2), half: Math.sqrt(rest / l2) },
    ],
  };
}

/**
 * ROI と平面の断面の輪郭（世界座標の閉じた点列、`n` 点）。交わらなければ null。
 * 平面は 点 `origin`＋面内の直交単位基底 `u`, `v`。楕円体は {@link ellipsoidSection} を `n` 分割、
 * 直方体は 12 辺と平面の交点を面内の角度順に並べる。
 */
export function sectionOutline(b: Pick<Roi3dBox, "shape" | "center" | "size">, origin: Vec3, u: Vec3, v: Vec3, n = 64): Vec3[] | null {
  if (b.shape === "ellipsoid") {
    const e = ellipsoidSection(b, origin, u, v);
    if (!e) return null;
    const [A, B] = e.axes;
    const pts: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n;
      const ca = Math.cos(th) * A.half;
      const sb = Math.sin(th) * B.half;
      pts.push([
        e.center[0] + ca * A.dir[0] + sb * B.dir[0],
        e.center[1] + ca * A.dir[1] + sb * B.dir[1],
        e.center[2] + ca * A.dir[2] + sb * B.dir[2],
      ]);
    }
    return pts;
  }
  const nrm = cross3(u, v);
  const corner = (i: number): Vec3 => [
    b.center[0] + (i & 1 ? 1 : -1) * (b.size[0] / 2),
    b.center[1] + (i & 2 ? 1 : -1) * (b.size[1] / 2),
    b.center[2] + (i & 4 ? 1 : -1) * (b.size[2] / 2),
  ];
  const dist = (p: Vec3): number => dot3([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]], nrm);
  const hits: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    for (const bit of [1, 2, 4]) {
      if (i & bit) continue; // 各辺を 1 回だけ（i が小さい側から）
      const p = corner(i);
      const q = corner(i | bit);
      const dp = dist(p);
      const dq = dist(q);
      if (dp * dq > 0) continue; // 同じ側
      if (dp === 0 && dq === 0) continue; // 辺が平面内: 端点は他の辺で拾う
      const t = dp === dq ? 0 : dp / (dp - dq);
      hits.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
    }
  }
  const uniq: Vec3[] = [];
  for (const h of hits) if (!uniq.some((x) => Math.hypot(x[0] - h[0], x[1] - h[1], x[2] - h[2]) < 1e-9)) uniq.push(h);
  if (uniq.length < 3) return null;
  const cen: Vec3 = [0, 1, 2].map((i) => uniq.reduce((a, p) => a + p[i], 0) / uniq.length) as Vec3;
  const ang = (p: Vec3): number => Math.atan2(dot3([p[0] - cen[0], p[1] - cen[1], p[2] - cen[2]], v), dot3([p[0] - cen[0], p[1] - cen[1], p[2] - cen[2]], u));
  return uniq.sort((a, b2) => ang(a) - ang(b2));
}
