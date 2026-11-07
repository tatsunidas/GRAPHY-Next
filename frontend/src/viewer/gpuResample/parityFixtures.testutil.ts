/*
 * Fusion リサンプルの回帰・一致検査のテスト入力。本番コードから import しない。
 *
 * 既存の fusionEngineTransform.test.ts の入力（軸位・等間隔・slope 1）より厳しくしてある:
 * 前景は傾いた IOP・不等間隔のスライス・スライスごとに違う slope・非等方の画素間隔・非正方の格子、
 * 背景は 2 軸に傾いた IOP。画素値は保存値（Int16）で、物理値への換算は slope/intercept 経由。
 */
import type { FusionVolume, BackgroundSliceMeta } from "../fusionEngine";
import {
  composeTransforms,
  dvfTransform,
  linearTransform,
  manualAdjustToTransform,
  mat4FromEulerDeg,
  type Vec3,
  type WorldTransform,
} from "../regTransform";

/** 再現可能な乱数（mulberry32）。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rotX(deg: number): Float64Array { return mat4FromEulerDeg(deg, 0, 0); }

/** 単位ベクトルの 3 成分を 3x3 の行から取る補助。 */
function col(m: Float64Array, c: number): Vec3 { return [m[c], m[4 + c], m[8 + c]]; }

export const FG_COLS = 24;
export const FG_ROWS = 20;
export const FG_PX_COL = 2.5;
export const FG_PX_ROW = 3.5;
/** 法線方向の位置 [mm]（不等間隔）。 */
export const FG_W = [0, 1, 3, 4.5, 5.5, 8, 9];
/** スライスごとの slope（PET 風に違う）と intercept。 */
export const FG_SLOPE = [1.0, 1.7, 0.6, 2.3, 1.1, 0.9, 1.9];
export const FG_INTERCEPT = [0, -3, 5, 0, -8, 2, 1];

export function makeFusionFixtureFg(seed = 1): FusionVolume {
  const r = rng(seed);
  // 前景の IOP: x 軸まわりに 10° 傾けた面。法線 = row × col。
  const R = rotX(10);
  const rowDir = col(R, 0);
  const colDir = col(R, 1);
  const normal: Vec3 = [
    rowDir[1] * colDir[2] - rowDir[2] * colDir[1],
    rowDir[2] * colDir[0] - rowDir[0] * colDir[2],
    rowDir[0] * colDir[1] - rowDir[1] * colDir[0],
  ];
  const slices = FG_W.map((w, k) => {
    const px = new Int16Array(FG_COLS * FG_ROWS);
    for (let i = 0; i < px.length; i++) px[i] = Math.round(r() * 2000 - 500);
    return {
      ipp: [-30 + w * normal[0], -35 + w * normal[1], -4.5 + w * normal[2]] as Vec3,
      pixels: px,
      slope: FG_SLOPE[k],
      intercept: FG_INTERCEPT[k],
    };
  });
  return {
    iop: [rowDir[0], rowDir[1], rowDir[2], colDir[0], colDir[1], colDir[2]],
    pixelSpacingCol: FG_PX_COL,
    pixelSpacingRow: FG_PX_ROW,
    cols: FG_COLS,
    rows: FG_ROWS,
    slices,
  };
}

export const BG_COLS = 40;
export const BG_ROWS = 36;

/** 背景スライス: z 軸まわり 20°・x 軸まわり 15° に傾いた面。zOffset は法線方向のずらし [mm]。 */
export function makeFusionFixtureBg(zOffset = 0): BackgroundSliceMeta {
  const Rz = mat4FromEulerDeg(0, 0, 20);
  const Rx = mat4FromEulerDeg(15, 0, 0);
  const R = new Float64Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += Rz[i * 4 + k] * Rx[k * 4 + j];
    R[i * 4 + j] = s;
  }
  const rowDir = col(R, 0);
  const colDir = col(R, 1);
  const n: Vec3 = [
    rowDir[1] * colDir[2] - rowDir[2] * colDir[1],
    rowDir[2] * colDir[0] - rowDir[0] * colDir[2],
    rowDir[0] * colDir[1] - rowDir[1] * colDir[0],
  ];
  const sx = 1.7, sy = 2.1;
  // スライスの中心が前景の中心付近に来るように IPP を置く。
  const center: Vec3 = [-30 + 30, -35 + 35, 0];
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

function rigid(rx: number, ry: number, rz: number, t: Vec3, center: Vec3): WorldTransform {
  const m = mat4FromEulerDeg(rx, ry, rz);
  m[3] = t[0]; m[7] = t[1]; m[11] = t[2];
  return linearTransform(m, { dof: 6, center });
}

function makeDvf(seed: number): WorldTransform {
  const r = rng(seed);
  const dims: [number, number, number] = [6, 6, 5];
  const d = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
  for (let i = 0; i < d.length; i++) d[i] = (r() - 0.5) * 8;
  return dvfTransform(d, dims, [-20, -25, -12], [14, 14, 6]);
}

/** 変換 5 通り + 多段（linear→DVF→linear）。null は xf 省略。 */
export function fusionFixtureTransforms(): { name: string; xf: WorldTransform | null }[] {
  const c: Vec3 = [0, 0, 0];
  const rg = rigid(4, -3, 15, [3.2, -2.1, 1.3], c);
  const manual = manualAdjustToTransform({ tx: 2, ty: -3, tz: 1.5, rx: 3, ry: -2, rz: 12 }, [0, 0, 0]);
  const dvf = makeDvf(7);
  return [
    { name: "恒等", xf: null },
    { name: "剛体(15°)", xf: rg },
    { name: "手動微調整", xf: manual },
    { name: "DVF", xf: dvf },
    { name: "合成(DVF→剛体)", xf: composeTransforms(dvf, rg) },
    { name: "多段(剛体→DVF→手動)", xf: composeTransforms(rg, dvf, manual) },
  ];
}
