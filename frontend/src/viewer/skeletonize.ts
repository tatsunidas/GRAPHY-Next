/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D 骨格化（Lee-Kashyap-Chu 1994 の並列細線化）。旧 GRAPHY `centerline/Skeletonizer3D`（＝ Fiji
 * `sc.fiji.skeletonize3D.Skeletonize3D_` / Hanno Homann の ITK BinaryThinningImageFilter3D）の**忠実移植**。
 *
 * vtk.js / cornerstone に 3D thinning は無いため（`fw/3d-viewer-design.md` §10 唯一の重量級）、自前実装する。
 * アルゴリズムの各定数（Euler LUT・8 オクタントのビット割当・isSimplePoint の octree ラベリング・境界方向）は
 * Fiji の実バイトコード（`Skeletonize3D_-2.1.1.jar`）から抽出して 1:1 で再現している（数値一致）。
 *
 * 入力: 二値 labelmap（`LabelVolume`, 前景>0）。出力: 1 ボクセル幅の骨格（0/1, 同一 geom）。
 * 速度のため占有 bbox＋余白でクロップしてから細線化し、geom の origin を平行移動して整合を保つ。
 */
import {
  type LabelVolume,
  type VolumeGeom,
  voxelToWorld,
} from "./labelVolume";

// 近傍レイアウト（getNeighborhood と同一）: index = (dz+1)*9 + (dy+1)*3 + (dx+1)、中心 = 13。
// Euler 特性 LUT（奇数 index のみ非 0。Fiji バイトコードから抽出）。
// prettier-ignore
const EULER_LUT: number[] = [
  0, 1, 0, -1, 0, -1, 0, 1, 0, -3, 0, -1, 0, -1, 0, 1,
  0, -1, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1,
  0, -3, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1,
  0, -1, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1,
  0, -3, 0, 3, 0, -1, 0, 1, 0, 1, 0, 3, 0, -1, 0, 1,
  0, -1, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1,
  0, 1, 0, 3, 0, 3, 0, 1, 0, 5, 0, 3, 0, 3, 0, 1,
  0, -1, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1,
  0, -7, 0, -1, 0, -1, 0, 1, 0, -3, 0, -1, 0, -1, 0, 1,
  0, -1, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1,
  0, -3, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1,
  0, -1, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1,
  0, -3, 0, 3, 0, -1, 0, 1, 0, 1, 0, 3, 0, -1, 0, 1,
  0, -1, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1,
  0, 1, 0, 3, 0, 3, 0, 1, 0, 5, 0, 3, 0, 3, 0, 1,
  0, -1, 0, 1, 0, 1, 0, -1, 0, 3, 0, 1, 0, 1, 0, -1,
];

export interface SkeletonResult {
  /** 0/1 の骨格ボクセル（geom.dims の順序＝ x fastest, z slowest）。 */
  data: Uint8Array;
  /** クロップ後の実空間幾何（origin は bbox に合わせて平行移動済み）。 */
  geom: VolumeGeom;
}

/**
 * LabelVolume を骨格化する。占有 bbox（＋margin）にクロップして細線化。
 * 前景が無ければ null。
 */
export function skeletonizeLabelVolume(lv: LabelVolume, margin = 2): SkeletonResult | null {
  const cropped = cropToForeground(lv, margin);
  if (!cropped) return null;
  const { data, geom } = cropped;
  const [w, h, d] = geom.dims;
  // 二値化（0/1）。
  const vol = new Uint8Array(w * h * d);
  for (let i = 0; i < vol.length; i++) vol[i] = data[i] > 0 ? 1 : 0;
  computeThinImage(vol, w, h, d);
  return { data: vol, geom };
}

/** 占有 bbox＋margin にクロップした LabelVolume（origin を平行移動）。 */
function cropToForeground(
  lv: LabelVolume,
  margin: number,
): { data: Uint8Array; geom: VolumeGeom } | null {
  const [nx, ny, nz] = lv.geom.dims;
  const frame = nx * ny;
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
  const src = lv.data;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const rowBase = k * frame + j * nx;
      for (let i = 0; i < nx; i++) {
        if (src[rowBase + i] > 0) {
          if (i < i0) i0 = i;
          if (i > i1) i1 = i;
          if (j < j0) j0 = j;
          if (j > j1) j1 = j;
          if (k < k0) k0 = k;
          if (k > k1) k1 = k;
        }
      }
    }
  }
  if (i1 < 0) return null; // 前景なし
  i0 = Math.max(0, i0 - margin); j0 = Math.max(0, j0 - margin); k0 = Math.max(0, k0 - margin);
  i1 = Math.min(nx - 1, i1 + margin); j1 = Math.min(ny - 1, j1 + margin); k1 = Math.min(nz - 1, k1 + margin);
  const cw = i1 - i0 + 1, ch = j1 - j0 + 1, cd = k1 - k0 + 1;
  const out = new Uint8Array(cw * ch * cd);
  const cframe = cw * ch;
  for (let k = 0; k < cd; k++) {
    for (let j = 0; j < ch; j++) {
      const srcBase = (k + k0) * frame + (j + j0) * nx + i0;
      const dstBase = k * cframe + j * cw;
      for (let i = 0; i < cw; i++) out[dstBase + i] = src[srcBase + i];
    }
  }
  // origin を bbox 先頭ボクセルへ平行移動（direction/spacing は不変）。
  const origin = voxelToWorld(lv.geom, i0, j0, k0);
  const geom: VolumeGeom = {
    dims: [cw, ch, cd],
    spacing: lv.geom.spacing.slice() as [number, number, number],
    origin: [origin[0], origin[1], origin[2]],
    direction: lv.geom.direction.slice(),
  };
  return { data: out, geom };
}

// ── Lee-94 細線化本体（Fiji Skeletonize3D_.computeThinImage の移植）─────────

function computeThinImage(vol: Uint8Array, w: number, h: number, d: number): void {
  const slice = w * h;
  const getPixel = (x: number, y: number, z: number): number => {
    if (x < 0 || x >= w || y < 0 || y >= h || z < 0 || z >= d) return 0;
    return vol[z * slice + y * w + x];
  };
  const neigh = new Int32Array(27);
  const fillNeighborhood = (x: number, y: number, z: number): void => {
    let idx = 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) neigh[idx++] = getPixel(x + dx, y + dy, z + dz);
  };

  // 境界方向の面近傍（currentBorder 1=N(y-1) 2=S(y+1) 3=E(x+1) 4=W(x-1) 5=U(z+1) 6=B(z-1)）。
  const isBorder = (x: number, y: number, z: number, border: number): boolean => {
    switch (border) {
      case 1: return getPixel(x, y - 1, z) <= 0;
      case 2: return getPixel(x, y + 1, z) <= 0;
      case 3: return getPixel(x + 1, y, z) <= 0;
      case 4: return getPixel(x - 1, y, z) <= 0;
      case 5: return getPixel(x, y, z + 1) <= 0;
      case 6: return getPixel(x, y, z - 1) <= 0;
      default: return false;
    }
  };

  const simpleBorderPoints: number[] = []; // フラット [x,y,z, x,y,z, ...]
  let unchangedBorders = 0;
  while (unchangedBorders < 6) {
    unchangedBorders = 0;
    for (let currentBorder = 1; currentBorder <= 6; currentBorder++) {
      let noChange = true;
      simpleBorderPoints.length = 0;
      for (let z = 0; z < d; z++) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (vol[z * slice + y * w + x] !== 1) continue;
            if (!isBorder(x, y, z, currentBorder)) continue;
            if (isEndPoint(getPixel, x, y, z)) continue;
            fillNeighborhood(x, y, z);
            if (!isEulerInvariant(neigh)) continue;
            if (!isSimplePoint(neigh)) continue;
            simpleBorderPoints.push(x, y, z);
          }
        }
      }
      // 逐次削除（削除ごとに近傍を取り直して再判定）。
      for (let p = 0; p < simpleBorderPoints.length; p += 3) {
        const x = simpleBorderPoints[p], y = simpleBorderPoints[p + 1], z = simpleBorderPoints[p + 2];
        fillNeighborhood(x, y, z);
        if (isSimplePoint(neigh)) {
          vol[z * slice + y * w + x] = 0;
          noChange = false;
        }
      }
      if (noChange) unchangedBorders++;
    }
  }
}

/** 端点判定: 中心を除く前景近傍が 1 個。 */
function isEndPoint(
  getPixel: (x: number, y: number, z: number) => number,
  x: number,
  y: number,
  z: number,
): boolean {
  let n = -1; // 中心自身を差し引く
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (getPixel(x + dx, y + dy, z + dz) === 1) n++;
  return n === 1;
}

// 8 オクタントの index 化（各ビット割当は Fiji バイトコードから抽出）。n は 1 起点。
function idxSWU(n: Int32Array): number {
  let x = 1;
  if (n[24]) x |= 128; if (n[25]) x |= 64; if (n[15]) x |= 32; if (n[16]) x |= 16;
  if (n[21]) x |= 8; if (n[22]) x |= 4; if (n[12]) x |= 2;
  return x;
}
function idxSEU(n: Int32Array): number {
  let x = 1;
  if (n[26]) x |= 128; if (n[23]) x |= 64; if (n[17]) x |= 32; if (n[14]) x |= 16;
  if (n[25]) x |= 8; if (n[22]) x |= 4; if (n[16]) x |= 2;
  return x;
}
function idxNWU(n: Int32Array): number {
  let x = 1;
  if (n[18]) x |= 128; if (n[21]) x |= 64; if (n[9]) x |= 32; if (n[12]) x |= 16;
  if (n[19]) x |= 8; if (n[22]) x |= 4; if (n[10]) x |= 2;
  return x;
}
function idxNEU(n: Int32Array): number {
  let x = 1;
  if (n[20]) x |= 128; if (n[23]) x |= 64; if (n[19]) x |= 32; if (n[22]) x |= 16;
  if (n[11]) x |= 8; if (n[14]) x |= 4; if (n[10]) x |= 2;
  return x;
}
function idxSWB(n: Int32Array): number {
  let x = 1;
  if (n[6]) x |= 128; if (n[15]) x |= 64; if (n[7]) x |= 32; if (n[16]) x |= 16;
  if (n[3]) x |= 8; if (n[12]) x |= 4; if (n[4]) x |= 2;
  return x;
}
function idxSEB(n: Int32Array): number {
  let x = 1;
  if (n[8]) x |= 128; if (n[7]) x |= 64; if (n[17]) x |= 32; if (n[16]) x |= 16;
  if (n[5]) x |= 8; if (n[4]) x |= 4; if (n[14]) x |= 2;
  return x;
}
function idxNWB(n: Int32Array): number {
  let x = 1;
  if (n[0]) x |= 128; if (n[9]) x |= 64; if (n[3]) x |= 32; if (n[12]) x |= 16;
  if (n[1]) x |= 8; if (n[10]) x |= 4; if (n[4]) x |= 2;
  return x;
}
function idxNEB(n: Int32Array): number {
  let x = 1;
  if (n[2]) x |= 128; if (n[1]) x |= 64; if (n[11]) x |= 32; if (n[10]) x |= 16;
  if (n[5]) x |= 8; if (n[4]) x |= 4; if (n[14]) x |= 2;
  return x;
}

/** Euler 不変性: 8 オクタントの LUT 和が 0。 */
function isEulerInvariant(n: Int32Array): boolean {
  let e = 0;
  e += EULER_LUT[idxSWU(n)];
  e += EULER_LUT[idxSEU(n)];
  e += EULER_LUT[idxNWU(n)];
  e += EULER_LUT[idxNEU(n)];
  e += EULER_LUT[idxSWB(n)];
  e += EULER_LUT[idxSEB(n)];
  e += EULER_LUT[idxNWB(n)];
  e += EULER_LUT[idxNEB(n)];
  return e === 0;
}

/** simple point 判定: 26 近傍（中心除く）の前景が単一連結成分か。 */
function isSimplePoint(neighbors: Int32Array): boolean {
  // 中心（13）を除いた 26 要素の cube を作る。
  const cube = new Int32Array(26);
  for (let i = 0; i < 13; i++) cube[i] = neighbors[i];
  for (let i = 14; i < 27; i++) cube[i - 1] = neighbors[i];
  let label = 2;
  for (let i = 0; i < 26; i++) {
    if (cube[i] !== 1) continue;
    // cube index が属する開始オクタントから伝播。
    switch (i) {
      case 0: case 1: case 3: case 4: case 9: case 10: case 12:
        octreeLabeling(1, label, cube); break;
      case 2: case 5: case 11: case 13:
        octreeLabeling(2, label, cube); break;
      case 6: case 7: case 14: case 15:
        octreeLabeling(3, label, cube); break;
      case 8: case 16:
        octreeLabeling(4, label, cube); break;
      case 17: case 18: case 20: case 21:
        octreeLabeling(5, label, cube); break;
      case 19: case 22:
        octreeLabeling(6, label, cube); break;
      case 23: case 24:
        octreeLabeling(7, label, cube); break;
      case 25:
        octreeLabeling(8, label, cube); break;
    }
    label++;
    if (label - 2 >= 2) return false; // 2 個以上の連結成分 → simple ではない
  }
  return true;
}

/**
 * octree ラベリング（再帰）。cube の前景を label で塗り、隣接オクタントへ伝播。
 * 分岐は Fiji `octreeLabeling` のバイトコードから 1:1 で移植。
 */
function octreeLabeling(octant: number, label: number, cube: Int32Array): void {
  if (octant === 1) {
    if (cube[0] === 1) cube[0] = label;
    if (cube[1] === 1) { cube[1] = label; octreeLabeling(2, label, cube); }
    if (cube[3] === 1) { cube[3] = label; octreeLabeling(3, label, cube); }
    if (cube[4] === 1) { cube[4] = label; octreeLabeling(2, label, cube); octreeLabeling(3, label, cube); octreeLabeling(4, label, cube); }
    if (cube[9] === 1) { cube[9] = label; octreeLabeling(5, label, cube); }
    if (cube[10] === 1) { cube[10] = label; octreeLabeling(2, label, cube); octreeLabeling(5, label, cube); octreeLabeling(6, label, cube); }
    if (cube[12] === 1) { cube[12] = label; octreeLabeling(3, label, cube); octreeLabeling(5, label, cube); octreeLabeling(7, label, cube); }
  }
  if (octant === 2) {
    if (cube[1] === 1) { cube[1] = label; octreeLabeling(1, label, cube); }
    if (cube[4] === 1) { cube[4] = label; octreeLabeling(1, label, cube); octreeLabeling(3, label, cube); octreeLabeling(4, label, cube); }
    if (cube[10] === 1) { cube[10] = label; octreeLabeling(1, label, cube); octreeLabeling(5, label, cube); octreeLabeling(6, label, cube); }
    if (cube[2] === 1) cube[2] = label;
    if (cube[5] === 1) { cube[5] = label; octreeLabeling(4, label, cube); }
    if (cube[11] === 1) { cube[11] = label; octreeLabeling(6, label, cube); }
    if (cube[13] === 1) { cube[13] = label; octreeLabeling(4, label, cube); octreeLabeling(6, label, cube); octreeLabeling(8, label, cube); }
  }
  if (octant === 3) {
    if (cube[3] === 1) { cube[3] = label; octreeLabeling(1, label, cube); }
    if (cube[4] === 1) { cube[4] = label; octreeLabeling(1, label, cube); octreeLabeling(2, label, cube); octreeLabeling(4, label, cube); }
    if (cube[12] === 1) { cube[12] = label; octreeLabeling(1, label, cube); octreeLabeling(5, label, cube); octreeLabeling(7, label, cube); }
    if (cube[6] === 1) cube[6] = label;
    if (cube[7] === 1) { cube[7] = label; octreeLabeling(4, label, cube); }
    if (cube[14] === 1) { cube[14] = label; octreeLabeling(7, label, cube); }
    if (cube[15] === 1) { cube[15] = label; octreeLabeling(4, label, cube); octreeLabeling(7, label, cube); octreeLabeling(8, label, cube); }
  }
  if (octant === 4) {
    if (cube[4] === 1) { cube[4] = label; octreeLabeling(1, label, cube); octreeLabeling(2, label, cube); octreeLabeling(3, label, cube); }
    if (cube[5] === 1) { cube[5] = label; octreeLabeling(2, label, cube); }
    if (cube[13] === 1) { cube[13] = label; octreeLabeling(2, label, cube); octreeLabeling(6, label, cube); octreeLabeling(8, label, cube); }
    if (cube[7] === 1) { cube[7] = label; octreeLabeling(3, label, cube); }
    if (cube[15] === 1) { cube[15] = label; octreeLabeling(3, label, cube); octreeLabeling(7, label, cube); octreeLabeling(8, label, cube); }
    if (cube[8] === 1) cube[8] = label;
    if (cube[16] === 1) { cube[16] = label; octreeLabeling(8, label, cube); }
  }
  if (octant === 5) {
    if (cube[9] === 1) { cube[9] = label; octreeLabeling(1, label, cube); }
    if (cube[10] === 1) { cube[10] = label; octreeLabeling(1, label, cube); octreeLabeling(2, label, cube); octreeLabeling(6, label, cube); }
    if (cube[12] === 1) { cube[12] = label; octreeLabeling(1, label, cube); octreeLabeling(3, label, cube); octreeLabeling(7, label, cube); }
    if (cube[17] === 1) cube[17] = label;
    if (cube[18] === 1) { cube[18] = label; octreeLabeling(6, label, cube); }
    if (cube[20] === 1) { cube[20] = label; octreeLabeling(7, label, cube); }
    if (cube[21] === 1) { cube[21] = label; octreeLabeling(6, label, cube); octreeLabeling(7, label, cube); octreeLabeling(8, label, cube); }
  }
  if (octant === 6) {
    if (cube[10] === 1) { cube[10] = label; octreeLabeling(1, label, cube); octreeLabeling(2, label, cube); octreeLabeling(5, label, cube); }
    if (cube[11] === 1) { cube[11] = label; octreeLabeling(2, label, cube); }
    if (cube[13] === 1) { cube[13] = label; octreeLabeling(2, label, cube); octreeLabeling(4, label, cube); octreeLabeling(8, label, cube); }
    if (cube[18] === 1) { cube[18] = label; octreeLabeling(5, label, cube); }
    if (cube[21] === 1) { cube[21] = label; octreeLabeling(5, label, cube); octreeLabeling(7, label, cube); octreeLabeling(8, label, cube); }
    if (cube[19] === 1) cube[19] = label;
    if (cube[22] === 1) { cube[22] = label; octreeLabeling(8, label, cube); }
  }
  if (octant === 7) {
    if (cube[12] === 1) { cube[12] = label; octreeLabeling(1, label, cube); octreeLabeling(3, label, cube); octreeLabeling(5, label, cube); }
    if (cube[14] === 1) { cube[14] = label; octreeLabeling(3, label, cube); }
    if (cube[15] === 1) { cube[15] = label; octreeLabeling(3, label, cube); octreeLabeling(4, label, cube); octreeLabeling(8, label, cube); }
    if (cube[20] === 1) { cube[20] = label; octreeLabeling(5, label, cube); }
    if (cube[21] === 1) { cube[21] = label; octreeLabeling(5, label, cube); octreeLabeling(6, label, cube); octreeLabeling(8, label, cube); }
    if (cube[23] === 1) cube[23] = label;
    if (cube[24] === 1) { cube[24] = label; octreeLabeling(8, label, cube); }
  }
  if (octant === 8) {
    if (cube[13] === 1) { cube[13] = label; octreeLabeling(2, label, cube); octreeLabeling(4, label, cube); octreeLabeling(6, label, cube); }
    if (cube[15] === 1) { cube[15] = label; octreeLabeling(3, label, cube); octreeLabeling(4, label, cube); octreeLabeling(7, label, cube); }
    if (cube[16] === 1) { cube[16] = label; octreeLabeling(4, label, cube); }
    if (cube[21] === 1) { cube[21] = label; octreeLabeling(5, label, cube); octreeLabeling(6, label, cube); octreeLabeling(7, label, cube); }
    if (cube[22] === 1) { cube[22] = label; octreeLabeling(6, label, cube); }
    if (cube[24] === 1) { cube[24] = label; octreeLabeling(7, label, cube); }
    if (cube[25] === 1) cube[25] = label;
  }
}
