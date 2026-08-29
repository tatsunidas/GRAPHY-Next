/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QCA の**ストレート像**（中心線に沿ってまっすぐ引き延ばした画像）— `fw/angio-design.md` §8.9。
 *
 * <h3>何のためにあるのか</h3>
 * 曲がった血管を曲がったまま見ると、**エッジのずれが「曲がりのせい」に見えて判別しにくい**。
 * 中心線を横軸・法線方向を縦軸に取り直すと、内腔は帯になり、径の変化とエッジの外れが
 * そのまま**上下のがたつき**として出る。市販の QCA が例外なくこの表示を持つのはこのため。
 *
 * <h3>座標系（ここが全部）</h3>
 * - 横 `col` … 中心線に沿った**弧長**（画像 px 等間隔）。
 * - 縦 `row` … 法線方向の符号付きオフセット `d = row − halfWidthPx`（画像 px）。
 *   `result.edgeOffsets` と**同じ量・同じ符号**（left &lt; 0 &lt; right）なので、
 *   帯の上でエッジを掴んで動かすことが、そのまま `onEdgeEdit(pathIndex, side, offset)` になる。
 *
 * <p>🔴 **横軸は「計測点の添字」ではなく弧長で取る。** 中心線は画素を辿った経路なので、
 * 隣り合う点の間隔は斜めの所で √2 倍になる。添字で並べると**斜めの区間だけ 41% 縮んだ**
 * 像になり、病変長を目で読むと嘘になる。
 *
 * <p>🔴 **法線は補間したら正規化し直す。** 2 点の単位ベクトルの中点は単位ベクトルではないので、
 * そのまま使うとカーブの内側で**サンプル間隔が詰まり**、帯の幅が実際より細く出る。
 */

import { sampleBilinear } from "./qca";

export interface StraightenInput {
  /** 計測点の中心線（画像 px）。 */
  centerline: readonly (readonly [number, number])[];
  /** 計測点の法線（単位ベクトル・画像座標）。`centerline` と同じ長さ。 */
  normals: readonly (readonly [number, number])[];
  /** 解析に使った画素（モダリティ値）。 */
  pixels: Float32Array;
  width: number;
  height: number;
  /** 帯の片側の高さ [画像 px]。内腔の外側も見えるだけ取る。 */
  halfWidthPx: number;
  /** 8bit へ落とす窓（本画面と**同じ窓**を渡すこと。違う窓だと別の画像に見える）。 */
  lo: number;
  hi: number;
  /** 列の間隔 [画像 px]。既定 1（＝等倍）。 */
  stepPx?: number;
}

export interface Straightened {
  cols: number;
  rows: number;
  halfWidthPx: number;
  stepPx: number;
  /** 中心線の全長 [画像 px]。 */
  lengthPx: number;
  /** 列 → 計測点の**連続**添字（掴んだ列から計測点を引く）。 */
  colToIndex: Float32Array;
  /** 計測点 → 列（描画は補間せずここを使う）。 */
  indexToCol: Float32Array;
  /** グレースケール（`cols × rows`・row major は使わず **col major**: `gray[col * rows + row]`）。 */
  gray: Uint8ClampedArray;
}

/** 中心線の累積弧長 [px]。 */
export function cumulativeLength(points: readonly (readonly [number, number])[]): Float64Array {
  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  return cum;
}

/**
 * 弧長 `s` の位置にある中心点と法線を、計測点の間で線形補間して返す。
 *
 * <p>返す `index` は**連続**添字（3.4 なら 3 番と 4 番の間）。
 */
export function sampleAlong(
  centerline: readonly (readonly [number, number])[],
  normals: readonly (readonly [number, number])[],
  cum: Float64Array,
  s: number,
): { x: number; y: number; nx: number; ny: number; index: number } {
  const n = centerline.length;
  const last = n - 1;
  if (s <= 0) {
    return { x: centerline[0][0], y: centerline[0][1], nx: normals[0][0], ny: normals[0][1], index: 0 };
  }
  if (s >= cum[last]) {
    return {
      x: centerline[last][0],
      y: centerline[last][1],
      nx: normals[last][0],
      ny: normals[last][1],
      index: last,
    };
  }
  // 二分探索（列数 × 計測点数の線形探索は、なでるたびに効いてくる）。
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span > 0 ? (s - cum[lo]) / span : 0;
  const x = centerline[lo][0] + (centerline[hi][0] - centerline[lo][0]) * t;
  const y = centerline[lo][1] + (centerline[hi][1] - centerline[lo][1]) * t;
  let nx = normals[lo][0] + (normals[hi][0] - normals[lo][0]) * t;
  let ny = normals[lo][1] + (normals[hi][1] - normals[lo][1]) * t;
  // 🔴 正規化し直す（単位ベクトルの中点は単位ベクトルではない）。
  //    ほぼ真逆を向いた 2 本を混ぜて 0 になったときは、片方をそのまま使う。
  const len = Math.hypot(nx, ny);
  if (len > 1e-6) {
    nx /= len;
    ny /= len;
  } else {
    nx = normals[lo][0];
    ny = normals[lo][1];
  }
  return { x, y, nx, ny, index: lo + t };
}

/**
 * ストレート像を作る。計測点が 2 点未満なら null。
 *
 * <p>⚠️ **画素は本画面と同じ窓で 8bit に落とす。** ここだけ自動窓にすると、同じ血管が
 * 隣同士で違う明るさに出て「別の画像」に見える。
 */
export function buildStraightened(input: StraightenInput): Straightened | null {
  const { centerline, normals, pixels, width, height, lo, hi } = input;
  const n = Math.min(centerline.length, normals.length);
  if (n < 2) return null;
  const stepPx = input.stepPx && input.stepPx > 0 ? input.stepPx : 1;
  const halfWidthPx = Math.max(2, Math.round(input.halfWidthPx));
  const rows = halfWidthPx * 2 + 1;

  const cum = cumulativeLength(centerline.slice(0, n));
  const lengthPx = cum[n - 1];
  if (!(lengthPx > 0)) return null;
  const cols = Math.max(2, Math.round(lengthPx / stepPx) + 1);

  const colToIndex = new Float32Array(cols);
  const indexToCol = new Float32Array(n);
  for (let i = 0; i < n; i++) indexToCol[i] = cum[i] / stepPx;

  const span = hi - lo > 0 ? hi - lo : 1;
  const gray = new Uint8ClampedArray(cols * rows);
  for (let c = 0; c < cols; c++) {
    const s = Math.min(lengthPx, c * stepPx);
    const p = sampleAlong(centerline, normals, cum, s);
    colToIndex[c] = p.index;
    for (let r = 0; r < rows; r++) {
      const d = r - halfWidthPx;
      const v = sampleBilinear(pixels, width, height, p.x + p.nx * d, p.y + p.ny * d);
      gray[c * rows + r] = ((v - lo) / span) * 255;
    }
  }
  return { cols, rows, halfWidthPx, stepPx, lengthPx, colToIndex, indexToCol, gray };
}

/**
 * 帯の高さ（片側）を決める。
 *
 * <p>内腔だけだと**エッジを外へ引っ張れない**ので、いちばん外へ出ているエッジより
 * 外側まで取る。取りすぎると帯が縦に伸びて 1px の作業がしにくくなるので上限を置く。
 */
export function straightenHalfWidth(
  edgeOffsets: readonly { left: number; right: number }[],
  opts: { min?: number; max?: number; margin?: number } = {},
): number {
  const min = opts.min ?? 8;
  const max = opts.max ?? 48;
  const margin = opts.margin ?? 1.8;
  let maxAbs = 0;
  for (const o of edgeOffsets) {
    const a = Math.max(Math.abs(o.left), Math.abs(o.right));
    if (Number.isFinite(a) && a > maxAbs) maxAbs = a;
  }
  return Math.round(Math.min(max, Math.max(min, maxAbs * margin)));
}

/**
 * 連続添字の位置にある中心点と法線（帯の上で掴んだ場所を**画像座標へ戻す**のに使う）。
 *
 * <p>🔴 法線はここでも正規化し直す。しないと、掴んだ場所と入る中間点が**カーブの内側で
 * じわじわずれる**（ずれても値は出るので気付けない）。
 */
export function pointAtFractionalIndex(
  centerline: readonly (readonly [number, number])[],
  normals: readonly (readonly [number, number])[],
  fi: number,
): { x: number; y: number; nx: number; ny: number } {
  const n = Math.min(centerline.length, normals.length);
  const k = Math.max(0, Math.min(n - 2, Math.floor(fi)));
  const t = Math.max(0, Math.min(1, fi - k));
  const x = centerline[k][0] + (centerline[k + 1][0] - centerline[k][0]) * t;
  const y = centerline[k][1] + (centerline[k + 1][1] - centerline[k][1]) * t;
  let nx = normals[k][0] + (normals[k + 1][0] - normals[k][0]) * t;
  let ny = normals[k][1] + (normals[k + 1][1] - normals[k][1]) * t;
  const len = Math.hypot(nx, ny);
  if (len > 1e-6) {
    nx /= len;
    ny /= len;
  } else {
    nx = normals[k][0];
    ny = normals[k][1];
  }
  return { x, y, nx, ny };
}

/** ストレート像を `ImageData` に焼く（`gray` は col major なので詰め替える）。 */
export function straightenedToImageData(st: Straightened, ctx: CanvasRenderingContext2D): ImageData {
  const img = ctx.createImageData(st.cols, st.rows);
  for (let r = 0; r < st.rows; r++) {
    for (let c = 0; c < st.cols; c++) {
      const g = st.gray[c * st.rows + r];
      const i = (r * st.cols + c) * 4;
      img.data[i] = g;
      img.data[i + 1] = g;
      img.data[i + 2] = g;
      img.data[i + 3] = 255;
    }
  }
  return img;
}
