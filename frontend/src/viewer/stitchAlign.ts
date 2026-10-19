/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * つなぎ合わせの位置合わせ（入力ごとの平行移動・回転・拡大・反転）。純関数のみ。
 *
 * 入力の `indexToWorld/worldToIndex` を差し替えるだけなので、結合時の標本化（三線形補間）は元データから 1 回だけ行う。
 * 軸はすべて患者 LPS（X=左右、Y=前後、Z=頭尾）。回転の規約は `regTransform.mat4FromEulerDeg`（R = Rz·Ry·Rx）。
 */
import { mat4FromEulerDeg, mat4InvertAffine, mat4Multiply, mat4Identity } from "./regTransform";
import type { StitchInput } from "./volumeStitch";

export interface Placement {
  /** 平行移動 [mm]。 */
  tx: number; ty: number; tz: number;
  /** 回転 [度]（各軸まわり、体積中心が回転の中心）。 */
  rx: number; ry: number; rz: number;
  /** 拡大率（1 = 等倍）。 */
  sx: number; sy: number; sz: number;
  /** 軸ごとの反転（体積中心を通る面で鏡映）。 */
  flipX: boolean; flipY: boolean; flipZ: boolean;
}

export const IDENTITY_PLACEMENT: Readonly<Placement> = Object.freeze({
  tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, flipX: false, flipY: false, flipZ: false,
});

export function isIdentityPlacement(p: Placement | null | undefined): boolean {
  if (!p) return true;
  return p.tx === 0 && p.ty === 0 && p.tz === 0 && p.rx === 0 && p.ry === 0 && p.rz === 0 &&
    p.sx === 1 && p.sy === 1 && p.sz === 1 && !p.flipX && !p.flipY && !p.flipZ;
}

/** 入力の体積中心（world）。ボクセル中心の範囲の中点。 */
export function volumeCenter(input: StitchInput): [number, number, number] {
  const v = input.volume;
  const m = v.indexToWorld;
  const i = (v.dims[0] - 1) / 2, j = (v.dims[1] - 1) / 2, k = (v.dims[2] - 1) / 2;
  return [
    m[0] * i + m[1] * j + m[2] * k + m[3],
    m[4] * i + m[5] * j + m[6] * k + m[7],
    m[8] * i + m[9] * j + m[10] * k + m[11],
  ];
}

/** world 上で点を動かす 4×4: `T(c + t) · R · S · F · T(−c)`。 */
export function placementMatrix(p: Placement, c: readonly number[]): Float64Array {
  const R = mat4FromEulerDeg(p.rx, p.ry, p.rz);
  const d = [(p.flipX ? -1 : 1) * p.sx, (p.flipY ? -1 : 1) * p.sy, (p.flipZ ? -1 : 1) * p.sz];
  const L = mat4Identity();
  L[0] = d[0]; L[5] = d[1]; L[10] = d[2];
  const RL = mat4Multiply(R, L);
  const out = mat4Identity();
  for (let r = 0; r < 3; r++) {
    for (let q = 0; q < 3; q++) out[r * 4 + q] = RL[r * 4 + q];
    const t = r === 0 ? p.tx : r === 1 ? p.ty : p.tz;
    out[r * 4 + 3] = c[r] + t - (RL[r * 4] * c[0] + RL[r * 4 + 1] * c[1] + RL[r * 4 + 2] * c[2]);
  }
  return out;
}

function unit3(a: number, b: number, c: number): number[] {
  const n = Math.hypot(a, b, c) || 1;
  return [a / n, b / n, c / n];
}

/**
 * world 上の移動 `move`（4×4）を入力に適用した入力（データは共有。元は変えない）。
 * 間隔と IOP は新しい行列の列から求め直す。
 */
export function applyMove(input: StitchInput, move: Float64Array): StitchInput {
  const v = input.volume;
  const i2w = mat4Multiply(move, v.indexToWorld);
  const w2i = mat4InvertAffine(i2w);
  if (!w2i) throw new Error("stitchAlign: 位置合わせ後の幾何が特異（拡大率が 0 など）");
  const col = (c: number) => [i2w[c], i2w[4 + c], i2w[8 + c]];
  const sp: [number, number, number] = [
    Math.hypot(...col(0)), Math.hypot(...col(1)), Math.hypot(...col(2)),
  ];
  const rc = unit3(...(col(0) as [number, number, number]));
  const rr = unit3(...(col(1) as [number, number, number]));
  return { ...input, iop: [...rc, ...rr], volume: { ...v, indexToWorld: i2w, worldToIndex: w2i, spacing: sp } };
}

/** 配置を適用した入力。恒等ならそのまま返す（既定の出力は従来と同一）。 */
export function placeInput(input: StitchInput, p: Placement | null | undefined): StitchInput {
  if (isIdentityPlacement(p)) return input;
  return applyMove(input, placementMatrix(p as Placement, volumeCenter(input)));
}

/** 欄の値として使えるか（有限で、拡大率は正）。 */
export function placementError(p: Placement): "scale" | "number" | null {
  const nums = [p.tx, p.ty, p.tz, p.rx, p.ry, p.rz, p.sx, p.sy, p.sz];
  if (nums.some((x) => !Number.isFinite(x))) return "number";
  if (p.sx <= 0 || p.sy <= 0 || p.sz <= 0) return "scale";
  return null;
}

/**
 * world 上の移動 `move` を、体積中心 `c` まわりの {@link Placement}（平行移動＋回転）へ分解する。
 * 回転は R = Rz·Ry·Rx（`mat4FromEulerDeg` と同じ）。拡大・反転は含まない移動（剛体）が前提。
 */
export function placementFromRigid(move: Float64Array, c: readonly number[]): Placement {
  const toDeg = 180 / Math.PI;
  const ry = -Math.asin(Math.max(-1, Math.min(1, move[8])));
  const rx = Math.atan2(move[9], move[10]);
  const rz = Math.atan2(move[4], move[0]);
  const mx = move[0] * c[0] + move[1] * c[1] + move[2] * c[2] + move[3];
  const my = move[4] * c[0] + move[5] * c[1] + move[6] * c[2] + move[7];
  const mz = move[8] * c[0] + move[9] * c[1] + move[10] * c[2] + move[11];
  return { ...IDENTITY_PLACEMENT, tx: mx - c[0], ty: my - c[1], tz: mz - c[2], rx: rx * toDeg, ry: ry * toDeg, rz: rz * toDeg };
}

/**
 * 出力の間隔の既定 `[列, 行, スライス]` [mm]。基準を明示したときはその元の間隔、そうでなければ位置合わせ前の各入力の
 * 軸ごとの最小値（従来の既定。拡大で実寸を変えても影響を受けない）。`bases` は位置合わせ前の入力。
 */
export function defaultOutputSpacing(bases: readonly StitchInput[], refIdx: number | null): [number, number, number] {
  if (bases.length === 0) throw new Error("stitchAlign: 入力が無い");
  if (refIdx !== null) {
    const s = bases[refIdx].volume.spacing;
    return [s[0], s[1], s[2]];
  }
  return [0, 1, 2].map((a) => Math.min(...bases.map((b) => b.volume.spacing[a]))) as [number, number, number];
}

/** 派生シリーズの記述に残す文字列。恒等なら空。 */
export function describePlacement(p: Placement | null | undefined): string {
  if (!p || isIdentityPlacement(p)) return "";
  const f = (v: number) => String(Math.round(v * 1000) / 1000);
  const parts = [`t(${f(p.tx)},${f(p.ty)},${f(p.tz)})mm`];
  if (p.rx || p.ry || p.rz) parts.push(`r(${f(p.rx)},${f(p.ry)},${f(p.rz)})deg`);
  if (p.sx !== 1 || p.sy !== 1 || p.sz !== 1) parts.push(`s(${f(p.sx)},${f(p.sy)},${f(p.sz)})`);
  const flips = [p.flipX ? "X" : "", p.flipY ? "Y" : "", p.flipZ ? "Z" : ""].join("");
  if (flips) parts.push(`flip(${flips})`);
  return parts.join(" ");
}

/** 2 つの向きの法線どうしのなす角 [度]。 */
export function iopAngleDeg(a: readonly number[], b: readonly number[]): number {
  const n = (i: readonly number[]) => {
    const u = unit3(i[0], i[1], i[2]);
    const v = unit3(i[3], i[4], i[5]);
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  };
  const [p, q] = [n(a), n(b)];
  const cx = p[1] * q[2] - p[2] * q[1], cy = p[2] * q[0] - p[0] * q[2], cz = p[0] * q[1] - p[1] * q[0];
  const dot = p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  // 行方向のなす角も含めたいので、法線と行方向の大きい方を返す
  const ang = (x: number[], y: number[]) => {
    const c1 = x[1] * y[2] - x[2] * y[1], c2 = x[2] * y[0] - x[0] * y[2], c3 = x[0] * y[1] - x[1] * y[0];
    return Math.atan2(Math.hypot(c1, c2, c3), x[0] * y[0] + x[1] * y[1] + x[2] * y[2]);
  };
  const normalAng = Math.atan2(Math.hypot(cx, cy, cz), dot);
  const rowAng = ang(unit3(a[0], a[1], a[2]), unit3(b[0], b[1], b[2]));
  return (Math.max(normalAng, rowAng) * 180) / Math.PI;
}
