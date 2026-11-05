/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * GPU の一致検査（カナリア）に使う合成ボリューム。その GPU で初めて使うときに、GPU と CPU で同じ背景スライスを
 * 計算して一致検査器に通す。ドライバの不具合で別の値を出す GPU を、能力判定だけでは外せないため。
 *
 * 8 点補間・面内の境界・z 端のクランプ・不等間隔の z・スライスごとに違う slope・傾いた前景と背景・非正方の格子・
 * 恒等と剛体の両方が現れる最小の大きさにしてある（実データでだけ出る誤りは、実データの最初のスライスの検査で拾う）。
 * 乱数は固定の種から作る（再現できる）。
 */
import type { BackgroundSliceMeta, FusionVolume } from "../fusionEngine";
import { linearTransform, mat4FromEulerDeg, type Vec3, type WorldTransform } from "../regTransform";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FG_COLS = 24;
const FG_ROWS = 20;
const FG_W = [0, 1, 3, 4.5, 5.5, 8, 9]; // 法線方向の位置 [mm]（不等間隔）
const FG_SLOPE = [1.0, 1.7, 0.6, 2.3, 1.1, 0.9, 1.9];
const FG_INTERCEPT = [0, -3, 5, 0, -8, 2, 1];
const BG_COLS = 40;
const BG_ROWS = 36;

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function colOf(m: Float64Array, c: number): Vec3 {
  return [m[c], m[4 + c], m[8 + c]];
}

/** 前景: x 軸まわり 10° 傾けた面・画素間隔 2.5×3.5 mm・Int16 の保存値・スライスごとに違う slope。 */
export function canaryForeground(): FusionVolume {
  const r = rng(1);
  const R = mat4FromEulerDeg(10, 0, 0);
  const rowDir = colOf(R, 0);
  const colDir = colOf(R, 1);
  const normal = cross(rowDir, colDir);
  return {
    iop: [rowDir[0], rowDir[1], rowDir[2], colDir[0], colDir[1], colDir[2]],
    pixelSpacingCol: 2.5,
    pixelSpacingRow: 3.5,
    cols: FG_COLS,
    rows: FG_ROWS,
    slices: FG_W.map((w, k) => {
      const px = new Int16Array(FG_COLS * FG_ROWS);
      for (let i = 0; i < px.length; i++) px[i] = Math.round(r() * 2000 - 500);
      return {
        ipp: [-30 + w * normal[0], -35 + w * normal[1], -4.5 + w * normal[2]] as Vec3,
        pixels: px,
        slope: FG_SLOPE[k],
        intercept: FG_INTERCEPT[k],
      };
    }),
  };
}

/** 背景スライス: z 軸まわり 20°・x 軸まわり 15° に傾いた面。zOffset は法線方向のずらし [mm]。 */
export function canaryBackground(zOffset: number): BackgroundSliceMeta {
  const Rz = mat4FromEulerDeg(0, 0, 20);
  const Rx = mat4FromEulerDeg(15, 0, 0);
  const R = new Float64Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += Rz[i * 4 + k] * Rx[k * 4 + j];
    R[i * 4 + j] = s;
  }
  const rowDir = colOf(R, 0);
  const colDir = colOf(R, 1);
  const n = cross(rowDir, colDir);
  const sx = 1.7;
  const sy = 2.1;
  const center: Vec3 = [0, 0, 0];
  const ipp: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    ipp[k] = center[k] - ((BG_COLS - 1) / 2) * sx * rowDir[k] - ((BG_ROWS - 1) / 2) * sy * colDir[k] + zOffset * n[k];
  }
  return {
    iop: [rowDir[0], rowDir[1], rowDir[2], colDir[0], colDir[1], colDir[2]],
    ipp,
    pixelSpacingCol: sx,
    pixelSpacingRow: sy,
    cols: BG_COLS,
    rows: BG_ROWS,
  };
}

/** カナリアの入力: 恒等と剛体（回転 + 平行移動）× 背景 3 位置（z の内側・端のクランプ・範囲外にまたがる）。 */
export function canaryCases(): { name: string; bg: BackgroundSliceMeta; xf: WorldTransform | null }[] {
  const m = mat4FromEulerDeg(4, -3, 15);
  m[3] = 3.2; m[7] = -2.1; m[11] = 1.3;
  const rigid = linearTransform(m, { dof: 6 });
  const out: { name: string; bg: BackgroundSliceMeta; xf: WorldTransform | null }[] = [];
  for (const [name, xf] of [["identity", null], ["rigid", rigid]] as const) {
    for (const z of [-6, 0, 5]) out.push({ name: `${name}@${z}`, bg: canaryBackground(z), xf });
  }
  return out;
}
