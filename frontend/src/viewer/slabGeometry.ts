/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D SLAB モードの幾何（純関数・患者 LPS mm）。fw/slab-mip-design.md §A。
 *
 * <b>スラブ中心 ≡ 回転中心（カメラ焦点）</b>。スラブ面は焦点を通り、法線は視線方向（direction of projection）。
 * 前後移動・中心指定はカメラの焦点と位置を同じベクトルだけ平行移動して行う（平行投影なので見た目の拡大は不変）。
 */

export type Vec3 = [number, number, number];

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: readonly number[], s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function normalize(v: readonly number[]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

/** スラブ面 = 焦点を通り、法線 = 視線方向（単位）。 */
export function slabPlaneFromCamera(
  focalPoint: readonly number[],
  directionOfProjection: readonly number[],
): { origin: Vec3; normal: Vec3 } {
  return { origin: [focalPoint[0], focalPoint[1], focalPoint[2]], normal: normalize(directionOfProjection) };
}

/** depth の可動域(mm) = ボリューム外接箱の対角の半分（どの向きでも全域を通れる）。 */
export function maxSlabDepthMm(bounds: readonly number[]): number {
  if (bounds.length < 6) return 0;
  return Math.hypot(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]) / 2;
}

/** depth を ±可動域へ丸める。 */
export function clampSlabDepth(depthMm: number, maxMm: number): number {
  if (!Number.isFinite(depthMm)) return 0;
  return Math.max(-maxMm, Math.min(maxMm, depthMm));
}

/** 回転中心の「深さ」= ボリューム中心から焦点までの、現在の視線方向の符号付き距離(mm)。 */
export function depthAlongView(
  focal: readonly number[],
  volCenter: readonly number[],
  dop: readonly number[],
): number {
  return dot(sub(focal, volCenter), normalize(dop));
}

/** 深さを depthMm（±maxMm に丸め）にするための新しい焦点。視線に垂直な成分（画面上の位置）は保つ。 */
export function targetForDepth(
  focal: readonly number[],
  dop: readonly number[],
  volCenter: readonly number[],
  depthMm: number,
  maxMm: number,
): Vec3 {
  const n = normalize(dop);
  const cur = depthAlongView(focal, volCenter, n);
  return add(focal, scale(n, clampSlabDepth(depthMm, maxMm) - cur));
}

/** 焦点を target へ移す平行移動（位置にも同じベクトルを足す＝向き・距離・ズーム不変）。 */
export function translateCameraTo(
  focal: readonly number[],
  position: readonly number[],
  target: readonly number[],
): { focal: Vec3; position: Vec3 } {
  const d = sub(target, focal);
  return { focal: [target[0], target[1], target[2]], position: add(position, d) };
}

/** world 点 → 値（範囲外は null）。 */
export type WorldSampler = (w: Vec3) => number | null;

/**
 * ダブルクリックの中心指定: 視線レイとスラブ中心面の交点から、レイに沿って ±厚/2 を step 刻みでサンプルし、
 * MIP=最大値の点 / MINIP=最小値の点 / AVG=中心面上の点 を返す（表示で見えている構造の奥行きを拾う）。
 * レイが面と平行、またはスラブ内に有効サンプルが無ければ中心面上の交点（それも無ければ null）。
 */
export function pickSlabPoint(
  ray: { origin: readonly number[]; dir: readonly number[] },
  sample: WorldSampler,
  planePoint: readonly number[],
  planeNormal: readonly number[],
  thicknessMm: number,
  projection: "MIP" | "MINIP" | "AVG",
  stepMm: number,
): Vec3 | null {
  const dir = normalize(ray.dir);
  const n = normalize(planeNormal);
  const denom = dot(dir, n);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(sub(planePoint, ray.origin), n) / denom;
  const hit = add(ray.origin, scale(dir, t));
  if (projection === "AVG" || !(thicknessMm > 0) || !(stepMm > 0)) return hit;
  // レイ方向の移動量 s に対する面法線方向の距離は s·denom。±厚/2 に収まる範囲を歩く。
  const half = thicknessMm / 2 / Math.abs(denom);
  const steps = Math.min(4096, Math.ceil((2 * half) / stepMm));
  let best: Vec3 | null = null;
  let bestV = projection === "MIP" ? -Infinity : Infinity;
  let bestAbs = Infinity; // 同値なら中心面に近い方
  for (let i = 0; i <= steps; i++) {
    const s = -half + (2 * half * i) / (steps || 1);
    const p = add(hit, scale(dir, s));
    const v = sample(p);
    if (v == null || !Number.isFinite(v)) continue;
    const better = projection === "MIP" ? v > bestV : v < bestV;
    if (better || (v === bestV && Math.abs(s) < bestAbs)) {
      best = p;
      bestV = v;
      bestAbs = Math.abs(s);
    }
  }
  return best ?? hit;
}

// ── 自動回転シネ ─────────────────────────────────────────────

export interface SpinOptions {
  /** 左右（画面縦軸まわり＝azimuth）/ 上下（画面横軸まわり＝elevation）。 */
  axis: "horizontal" | "vertical";
  degPerSec: number;
  /** null=360° 連続。数値=±rangeDeg を往復。 */
  rangeDeg: number | null;
}

export interface SpinState {
  /** 開始向きからの累積角(度)。 */
  angle: number;
  /** 往復の向き（+1/−1）。 */
  dir: 1 | -1;
}

/** 経過 dtSec 分の回転量（delta 度）と次の状態。往復は ±rangeDeg で折り返す。 */
export function spinStep(state: SpinState, dtSec: number, opts: SpinOptions): { delta: number; next: SpinState } {
  const step = Math.max(0, opts.degPerSec) * Math.max(0, dtSec);
  if (opts.rangeDeg == null || !(opts.rangeDeg > 0)) {
    return { delta: step, next: { angle: state.angle + step, dir: 1 } };
  }
  const r = opts.rangeDeg;
  let target = state.angle + state.dir * step;
  let dir = state.dir;
  // 1 フレームで 2 回以上折り返すほど速くはしない前提。境界で反射。
  if (target > r) {
    target = 2 * r - target;
    dir = -1;
  } else if (target < -r) {
    target = -2 * r - target;
    dir = 1;
  }
  target = Math.max(-r, Math.min(r, target));
  return { delta: target - state.angle, next: { angle: target, dir } };
}
