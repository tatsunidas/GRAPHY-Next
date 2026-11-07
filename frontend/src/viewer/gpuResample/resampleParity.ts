/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * Fusion のリサンプルの「別の実装との一致検査」（純関数）。
 *
 * <p>基準は固定の閾値ではなく**画素ごとの誤差上界 E**: 別実装（GPU）の値が CPU の値と
 * 有効な全画素で |差| ≤ E なら一致とする（パーセンタイルではない: 512² の 0.1% は 262 画素で、
 * 境界やエッジだけに出る規則的な誤りを通しうる）。
 *
 * <p>E = Lu·δu + Lv·δv + Lw·δw + γ_interp·Σ重み·(|保存値|·|slope| + |intercept|) + 1 ulp32(|v|)
 * - Lu, Lv: 補間に効く保存値の隣同士の物理値差の最大（δ が 1 ボクセル未満なので隣のセルまで含めた 4×4 の窓）
 * - Lw: z の隣同士のスライスの値差 / 間隔の最大（mm あたり）。隣のスライス対まで含める
 * - 1 ulp32: CPU の結果を float32 に入れる丸めと、別実装の最終出力の丸めの両方（各 ½ ulp）
 * - float64 で読み直す側の丸め（保存値に slope を掛ける順序の違い）も 16·2⁻⁵³·Σ(...) で足す
 *
 * <p>有効／無効（NaN）の食い違いは、(u, v) が面内境界の ±0.5 から δ 以内の画素にだけ許し、
 * その数を `ambiguous` として別に数える（境界の曖昧画素）。
 */
import {
  fusionNeighborhood, prepareFusionSlice, type BackgroundSliceMeta, type FusionSlice, type FusionSliceContext,
  type FusionVolume,
} from "../fusionEngine";
import type { WorldTransform } from "../regTransform";
import { evaluatePlanWithBound, gamma, OP_COUNTS, planResample, U32 } from "./resamplePlan";

const U64 = 2 ** -53;

/** float32 の 1 ulp（|v| の位置での隣の値との間隔）。 */
export function ulp32(v: number): number {
  const a = Math.abs(v);
  if (a < 2 ** -126) return 2 ** -149;
  return 2 ** (Math.floor(Math.log2(a)) - 23);
}

interface SliceWindow {
  /** (u, v) での物理値（float64）。 */
  val: number;
  /** u 方向・v 方向の隣同士の物理値差の最大（4×4 の窓）。 */
  Lu: number;
  Lv: number;
  /** 丸めの項: Σ 重み·(|c|·|slope| + |intercept|)。 */
  mag: number;
}

function sliceWindow(s: FusionSlice, W: number, H: number, u: number, v: number): SliceWindow {
  const phys = (i: number, j: number) => s.pixels[j * W + i] * s.slope + s.intercept;
  const iu = Math.floor(u), iv = Math.floor(v);
  const iu0 = Math.max(0, iu), iu1 = Math.min(iu + 1, W - 1);
  const iv0 = Math.max(0, iv), iv1 = Math.min(iv + 1, H - 1);
  const uu = Math.min(1, Math.max(0, u - iu));
  const vv = Math.min(1, Math.max(0, v - iv));
  const w00 = (1 - uu) * (1 - vv), w10 = uu * (1 - vv), w01 = (1 - uu) * vv, w11 = uu * vv;
  const val = phys(iu0, iv0) * w00 + phys(iu1, iv0) * w10 + phys(iu0, iv1) * w01 + phys(iu1, iv1) * w11;
  const mag = (i: number, j: number, w: number) => w * (Math.abs(s.pixels[j * W + i]) * Math.abs(s.slope) + Math.abs(s.intercept));
  const m = mag(iu0, iv0, w00) + mag(iu1, iv0, w10) + mag(iu0, iv1, w01) + mag(iu1, iv1, w11);

  const ia = Math.max(0, iu - 1), ib = Math.min(W - 1, iu + 2);
  const ja = Math.max(0, iv - 1), jb = Math.min(H - 1, iv + 2);
  let Lu = 0, Lv = 0;
  for (let j = ja; j <= jb; j++) for (let i = ia; i < ib; i++) Lu = Math.max(Lu, Math.abs(phys(i + 1, j) - phys(i, j)));
  for (let i = ia; i <= ib; i++) for (let j = ja; j < jb; j++) Lv = Math.max(Lv, Math.abs(phys(i, j + 1) - phys(i, j)));
  return { val, Lu, Lv, mag: m };
}

export interface SliceBounds {
  /** 画素ごとの E。CPU が NaN の画素は 0。 */
  bound: Float64Array;
  /** 1: (u, v) が面内境界から δ 以内（有効／無効の食い違いを許す）。 */
  ambiguous: Uint8Array;
}

/** 背景 1 スライスの全画素について E と境界の曖昧画素を出す（CPU の経路と独立に 8 点を読み直す）。 */
export function boundsForSlice(fg: FusionVolume, bg: BackgroundSliceMeta, xf?: WorldTransform | null): SliceBounds {
  const n = bg.cols * bg.rows;
  const bound = new Float64Array(n);
  const ambiguous = new Uint8Array(n);
  const ctx = prepareFusionSlice(fg, bg, xf);
  if (!ctx) return { bound, ambiguous };
  const plan = planResample(fg, bg, xf);
  for (let by = 0; by < bg.rows; by++) {
    for (let bx = 0; bx < bg.cols; bx++) {
      const i = by * bg.cols + bx;
      const p = evaluatePlanWithBound(plan, bx, by);
      // (u, v) が面内境界 −0.5 / W−0.5 から δ 以内か（かつ、もう一方の軸は範囲内か δ 以内）
      const nearU = Math.abs(p.u + 0.5) <= p.du || Math.abs(p.u - (fg.cols - 0.5)) <= p.du;
      const nearV = Math.abs(p.v + 0.5) <= p.dv || Math.abs(p.v - (fg.rows - 0.5)) <= p.dv;
      const inU = p.u >= -0.5 - p.du && p.u <= fg.cols - 0.5 + p.du;
      const inV = p.v >= -0.5 - p.dv && p.v <= fg.rows - 0.5 + p.dv;
      if ((nearU && inV) || (nearV && inU)) ambiguous[i] = 1;

      const nb = fusionNeighborhood(ctx, bx, by);
      if (!nb) continue;
      bound[i] = pixelErrorBound(ctx, nb.u, nb.v, nb.w_mm, p.du, p.dv, p.dw);
    }
  }
  return { bound, ambiguous };
}

/** 1 画素の E。(u, v, w_mm) は CPU の値、(du, dv, dw) は座標誤差の上界。 */
export function pixelErrorBound(
  ctx: FusionSliceContext, u: number, v: number, w_mm: number, du: number, dv: number, dw: number,
): number {
  const { fg, wPos } = ctx;
  const d = fg.slices.length;
  // 使うスライス対（CPU と独立に線形に探す。端は 1 枚にクランプ）
  let iw = -1;
  if (w_mm >= wPos[0]) { iw = 0; while (iw < d - 1 && wPos[iw + 1] <= w_mm) iw++; }
  const lo = Math.max(0, Math.min(iw, d - 1)), hi = Math.min(d - 1, iw < 0 ? 0 : iw + 1);
  // 隣のスライス対まで含める
  const a = Math.max(0, lo - 1), b = Math.min(d - 1, hi + 1);
  const win: SliceWindow[] = [];
  for (let k = a; k <= b; k++) win.push(sliceWindow(fg.slices[k], fg.cols, fg.rows, u, v));
  let Lu = 0, Lv = 0, Lw = 0, mag = 0;
  for (const w of win) { Lu = Math.max(Lu, w.Lu); Lv = Math.max(Lv, w.Lv); }
  for (let k = lo; k <= hi; k++) mag = Math.max(mag, win[k - a].mag);
  // 端のクランプ（iw<0 / iw>=d-1）では z に依らない。内側では隣のスライス対の傾き（mm あたり）の最大
  const inside = iw >= 0 && iw < d - 1;
  let wMax = 0;
  if (inside) {
    for (let k = Math.max(0, iw - 1); k <= Math.min(d - 2, iw + 1); k++) {
      const dwk = wPos[k + 1] - wPos[k];
      if (dwk > 0) Lw = Math.max(Lw, Math.abs(win[k + 1 - a].val - win[k - a].val) / dwk);
    }
    for (let k = Math.max(0, iw - 1); k <= Math.min(d - 1, iw + 2); k++) wMax = Math.max(wMax, Math.abs(wPos[k]));
  }
  const vVal = inside
    ? win[iw - a].val + ((w_mm - wPos[iw]) / (wPos[iw + 1] - wPos[iw] || 1)) * (win[iw + 1 - a].val - win[iw - a].val)
    : win[lo - a].val;
  const dwEff = dw + 2 * U32 * wMax + gamma(3) * Math.abs(w_mm);
  return (
    Lu * du + Lv * dv + Lw * dwEff +
    (gamma(OP_COUNTS.interp) + 16 * U64) * mag +
    ulp32(vVal)
  );
}

export interface ParityResult {
  pixels: number;
  /** 両方が有限の画素数。 */
  valid: number;
  /** |差| > E の画素数 + 曖昧でない有効／無効の食い違い。0 なら一致。 */
  violations: number;
  /** 有効／無効が食い違ったが境界の曖昧画素として許した数。 */
  ambiguous: number;
  /** |差| / E の最大（有効な画素）。1 を超えれば違反。 */
  maxRatio: number;
  worst: { index: number; cpu: number; other: number; bound: number } | null;
}

export function checkResampleParity(cpu: Float32Array, other: Float32Array, b: SliceBounds): ParityResult {
  const r: ParityResult = { pixels: cpu.length, valid: 0, violations: 0, ambiguous: 0, maxRatio: 0, worst: null };
  for (let i = 0; i < cpu.length; i++) {
    const x = cpu[i], y = other[i];
    const xn = Number.isNaN(x), yn = Number.isNaN(y);
    if (xn && yn) continue;
    if (xn !== yn) {
      if (b.ambiguous[i]) r.ambiguous++; else r.violations++;
      continue;
    }
    r.valid++;
    const ratio = Math.abs(x - y) / b.bound[i];
    if (ratio > r.maxRatio) { r.maxRatio = ratio; r.worst = { index: i, cpu: x, other: y, bound: b.bound[i] }; }
    if (ratio > 1) r.violations++;
  }
  return r;
}
