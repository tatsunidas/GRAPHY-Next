/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * GRAPHY FusionEngine の TypeScript 移植。
 *
 * ImageOrientationPatient × ImagePositionPatient を用いたワールド座標変換 + 3D trilinear 補間で
 * 前景ボリュームを背景スライスの画素グリッドにリサンプリングする。
 *
 * アルゴリズム出典: GRAPHY/src/main/java/com/vis/core/fusion/ImagePairingEngine.java
 */

type Vec3 = [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** 1 スライス分のピクセルデータと空間メタ。 */
export interface FusionSlice {
  ipp: Vec3;
  /** ストレージ輝度値（rescale 前）。 */
  pixels: ArrayLike<number>;
  slope: number;
  intercept: number;
}

/** Fusion オーバーレイ対象ボリューム（前景シリーズ）。 */
export interface FusionVolume {
  /** IOP: [row0,row1,row2, col0,col1,col2]。 */
  iop: [number, number, number, number, number, number];
  /** 列方向ピクセル間隔 [mm]（1 ピクセル動くと iop[0..2] 方向に何 mm 移動するか）。 */
  pixelSpacingCol: number;
  /** 行方向ピクセル間隔 [mm]（1 ピクセル動くと iop[3..5] 方向に何 mm 移動するか）。 */
  pixelSpacingRow: number;
  cols: number;
  rows: number;
  /** z 昇順に並んだスライス配列。 */
  slices: FusionSlice[];
}

/** 背景スライスの空間メタ。 */
export interface BackgroundSliceMeta {
  iop: [number, number, number, number, number, number];
  ipp: Vec3;
  pixelSpacingCol: number;
  pixelSpacingRow: number;
  cols: number;
  rows: number;
}

/**
 * 前景ボリュームを背景スライスの画素グリッドにリサンプリングする。
 *
 * 返り値: Float32Array (size = bg.rows × bg.cols)。
 * 前景範囲外の画素は NaN。
 *
 * 計算量: O(bg.rows × bg.cols × log(fg.slices.length))
 */
export function computeFusionSlice(fg: FusionVolume, bg: BackgroundSliceMeta): Float32Array {
  const nOut = bg.rows * bg.cols;
  const out = new Float32Array(nOut);
  out.fill(NaN);

  const d = fg.slices.length;
  if (d === 0) return out;

  const fRr: Vec3 = [fg.iop[0], fg.iop[1], fg.iop[2]];
  const fRc: Vec3 = [fg.iop[3], fg.iop[4], fg.iop[5]];
  const fRs = cross(fRr, fRc); // 前景スライス法線

  const bRr: Vec3 = [bg.iop[0], bg.iop[1], bg.iop[2]];
  const bRc: Vec3 = [bg.iop[3], bg.iop[4], bg.iop[5]];

  const fgIpp0 = fg.slices[0].ipp;
  // 各前景スライスの法線方向距離（fgIpp0 基点）
  const wPos = fg.slices.map((s) => dot(sub(s.ipp, fgIpp0), fRs));

  const fgW = fg.cols;
  const fgH = fg.rows;
  const bPx = bg.pixelSpacingCol;
  const bPy = bg.pixelSpacingRow;
  const bgIpp = bg.ipp;

  for (let by = 0; by < bg.rows; by++) {
    const Py0 = bgIpp[0] + by * bPy * bRc[0];
    const Py1 = bgIpp[1] + by * bPy * bRc[1];
    const Py2 = bgIpp[2] + by * bPy * bRc[2];

    for (let bx = 0; bx < bg.cols; bx++) {
      // 背景画素 (bx=列, by=行) → ワールド座標
      const Px = Py0 + bx * bPx * bRr[0];
      const Py = Py1 + bx * bPx * bRr[1];
      const Pz = Py2 + bx * bPx * bRr[2];

      // ワールド → 前景座標
      const dx = Px - fgIpp0[0];
      const dy = Py - fgIpp0[1];
      const dz = Pz - fgIpp0[2];

      const u = (dx * fRr[0] + dy * fRr[1] + dz * fRr[2]) / fg.pixelSpacingCol;
      const v = (dx * fRc[0] + dy * fRc[1] + dz * fRc[2]) / fg.pixelSpacingRow;
      const w_mm = dx * fRs[0] + dy * fRs[1] + dz * fRs[2];

      // 面内境界チェック
      if (u < -0.5 || u > fgW - 0.5 || v < -0.5 || v > fgH - 0.5) continue;

      // z 方向 trilinear のための前景スライスインデックス探索
      const iw = lowerBound(wPos, w_mm);

      let val: number;
      if (iw < 0) {
        val = bilinear(fg.slices[0].pixels, fgW, fgH, u, v);
        if (!isNaN(val)) val = val * fg.slices[0].slope + fg.slices[0].intercept;
      } else if (iw >= d - 1) {
        val = bilinear(fg.slices[d - 1].pixels, fgW, fgH, u, v);
        if (!isNaN(val)) val = val * fg.slices[d - 1].slope + fg.slices[d - 1].intercept;
      } else {
        const dw = wPos[iw + 1] - wPos[iw];
        const wFrac = dw > 0 ? (w_mm - wPos[iw]) / dw : 0;
        val = trilinear(fg.slices[iw], fg.slices[iw + 1], fgW, fgH, u, v, wFrac);
      }

      if (!isNaN(val)) out[by * bg.cols + bx] = val;
    }
  }

  return out;
}

/** wPos[result] <= w_mm < wPos[result+1] となる最大インデックスを返す（境界外: <0 または >=d-1）。 */
function lowerBound(wPos: number[], w_mm: number): number {
  const d = wPos.length;
  if (d === 0 || w_mm < wPos[0]) return -1;
  if (w_mm >= wPos[d - 1]) return d - 1;
  let lo = 0, hi = d - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (wPos[mid] <= w_mm) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** バイリニア補間（1 スライス内）。範囲外は nearest clamp。 */
function bilinear(pixels: ArrayLike<number>, w: number, h: number, u: number, v: number): number {
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const iu1 = Math.min(iu + 1, w - 1);
  const iv1 = Math.min(iv + 1, h - 1);
  const iu0 = Math.max(0, iu);
  const iv0 = Math.max(0, iv);
  const uu = Math.min(1, Math.max(0, u - iu));
  const vv = Math.min(1, Math.max(0, v - iv));
  const c00 = pixels[iv0 * w + iu0];
  const c10 = pixels[iv0 * w + iu1];
  const c01 = pixels[iv1 * w + iu0];
  const c11 = pixels[iv1 * w + iu1];
  return c00 * (1 - uu) * (1 - vv) + c10 * uu * (1 - vv) + c01 * (1 - uu) * vv + c11 * uu * vv;
}

/** 3D trilinear 補間（2 スライス間）。rescale も適用して物理値を返す。 */
function trilinear(
  lo: FusionSlice,
  hi: FusionSlice,
  w: number,
  h: number,
  u: number,
  v: number,
  wFrac: number,
): number {
  const vLo = bilinear(lo.pixels, w, h, u, v) * lo.slope + lo.intercept;
  const vHi = bilinear(hi.pixels, w, h, u, v) * hi.slope + hi.intercept;
  return vLo * (1 - wFrac) + vHi * wFrac;
}

/**
 * Float32Array（物理値）を RGBA ImageData に変換する。
 * lut を指定するとカラーマッピングを適用する。NaN 画素は透明。
 */
export function toImageData(
  values: Float32Array,
  cols: number,
  rows: number,
  windowCenter: number,
  windowWidth: number,
  lut?: { r: number[]; g: number[]; b: number[] } | null,
): ImageData {
  const rgba = new Uint8ClampedArray(cols * rows * 4);
  const half = windowWidth / 2;
  const lo = windowCenter - half;
  const range = windowWidth;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isNaN(v)) {
      rgba[i * 4 + 3] = 0;
      continue;
    }
    const g = Math.round(Math.max(0, Math.min(255, ((v - lo) / range) * 255)));
    // 8bit 化で 0（=窓下限以下＝背景）になった画素は完全透明にする。
    // GRAPHY の ImageRoi.setZeroTransparent(true) 相当。これにより背景が黒く
    // 被って base が暗転するのを防ぎ、信号部分のみがオーバーレイされる。
    if (g === 0) {
      rgba[i * 4 + 3] = 0;
      continue;
    }
    rgba[i * 4] = lut ? lut.r[g] : g;
    rgba[i * 4 + 1] = lut ? lut.g[g] : g;
    rgba[i * 4 + 2] = lut ? lut.b[g] : g;
    rgba[i * 4 + 3] = 255;
  }
  return new ImageData(rgba, cols, rows);
}

/**
 * Float32Array の有限値から自動 W/L を推定する（平均 ± 2σ の範囲）。
 */
export function autoWindowLevel(values: Float32Array): { center: number; width: number } {
  let sum = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    if (!isNaN(values[i])) { sum += values[i]; count++; }
  }
  if (count === 0) return { center: 0, width: 400 };
  const mean = sum / count;
  let variance = 0;
  for (let i = 0; i < values.length; i++) {
    if (!isNaN(values[i])) variance += (values[i] - mean) ** 2;
  }
  const std = Math.sqrt(variance / count);
  return { center: mean, width: Math.max(1, std * 4) };
}
