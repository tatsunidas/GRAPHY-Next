/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Fusion の演算結果を画像として残すための、画素値どうしの演算（物理値＝HU・SUV など）。
 *
 * <p>画面の「差分（表示）」「乗算（表示）」（{@link ./fusionBlend}）は W/L・LUT を通した見た目の合成で、
 * ここでの演算とは別物。こちらは背景の格子へ位置合わせ込みでリサンプルした前景と背景の**値**を直接演算する。
 * 保存先の判断（元のモダリティで持てるか／Parametric Map にするか）もここに置く（単体テストできるように）。
 */
import type { FusionBlend } from "./fusionBlend";

/** 演算。diff = 前景 − 背景（符号付き）、absdiff = |前景 − 背景|、mult = 前景 × 背景。 */
export type FusionCalcOp = "diff" | "absdiff" | "mult";

export const FUSION_CALC_OPS: readonly FusionCalcOp[] = ["diff", "absdiff", "mult"];

/** Fusion バーの重ね方から、ダイアログの演算の初期値を決める。 */
export function initialCalcOp(blend: FusionBlend): FusionCalcOp {
  return blend === "multiply" ? "mult" : "diff";
}

/**
 * 同じ格子の 2 つの値配列を演算する。どちらかが非有限（NaN＝データ無し）なら結果も NaN
 * （0 で埋めない。前景の範囲外が「差が無い」ように見えるのを防ぐ）。
 */
export function combineVolumes(bg: Float32Array, fg: Float32Array, op: FusionCalcOp): Float32Array {
  if (bg.length !== fg.length) throw new Error("bg and fg must be on the same grid");
  const out = new Float32Array(bg.length);
  for (let n = 0; n < out.length; n++) {
    const b = bg[n];
    const f = fg[n];
    if (!Number.isFinite(b) || !Number.isFinite(f)) {
      out[n] = NaN;
      continue;
    }
    out[n] = op === "diff" ? f - b : op === "absdiff" ? Math.abs(f - b) : f * b;
  }
  return out;
}

/** 有限な画素の数（前景と背景が重なっている画素の数）。 */
export function countFinite(values: Float32Array): number {
  let c = 0;
  for (let n = 0; n < values.length; n++) if (Number.isFinite(values[n])) c++;
  return c;
}

/** 有限な画素の最小値。無ければ null。 */
export function finiteMinOrNull(values: Float32Array): number | null {
  let m = Infinity;
  for (let n = 0; n < values.length; n++) {
    const v = values[n];
    if (v < m) m = v; // NaN は比較が偽になり無視される
  }
  return Number.isFinite(m) ? m : null;
}

/** 演算に使う片側の入力の説明（単位は `resolveValueUnit`、SUV 校正中は SUV）。 */
export interface CalcSide {
  readonly unit: string;
  readonly modality: string;
}

export type CalcStorage =
  /** 背景のモダリティ・単位のまま派生シリーズ（16bit＋Rescale）にする。 */
  | { readonly kind: "derived" }
  /** 元のモダリティでは解釈できない量なので、Modality=OT の Parametric Map（Float）にする。 */
  | {
      readonly kind: "parametric";
      readonly label: string;
      readonly unitCode: string;
      readonly unitMeaning: string;
    };

const OP_SYMBOL: Record<FusionCalcOp, string> = { diff: "-", absdiff: "-", mult: "x" };
const OP_LABEL: Record<FusionCalcOp, string> = { diff: "FUSION_DIFF", absdiff: "FUSION_ABSDIFF", mult: "FUSION_MULT" };

function unitName(u: string): string {
  return u && u !== "raw" ? u : "a.u.";
}

/**
 * 保存形式を決める。
 *
 * <p>元のモダリティ・単位のまま持てるのは、**差分で、前景と背景のモダリティと単位が同じ**ときだけ
 * （CT−CT は HU のまま、PET−PET は SUV のまま）。乗算（HU×SUV のような量）と、単位の違うものどうしの差分は
 * 元のモダリティの量として読まれると誤りになるので、Parametric Map にして単位を明記する。
 */
export function planCalcStorage(op: FusionCalcOp, bg: CalcSide, fg: CalcSide): CalcStorage {
  if (op !== "mult" && bg.unit === fg.unit && bg.modality === fg.modality) return { kind: "derived" };
  const expr = op === "absdiff" ? `|${unitName(fg.unit)} - ${unitName(bg.unit)}|`
    : `${unitName(fg.unit)} ${OP_SYMBOL[op]} ${unitName(bg.unit)}`;
  return {
    kind: "parametric",
    label: OP_LABEL[op],
    // 単位コードの "1" は「単位なし」の意味になり、読み込み側が単位名を出さない。UCUM の注釈にする。
    unitCode: op === "mult" ? "{FUSION_PRODUCT}" : "{FUSION_DIFF}",
    unitMeaning: expr.slice(0, 64),
  };
}

/** 派生シリーズの式（DerivationDescription / LUTExplanation 用）。 */
export function describeCalc(op: FusionCalcOp, fgName: string, bgName: string): string {
  const e = op === "diff" ? `FG - BG` : op === "absdiff" ? `|FG - BG|` : `FG x BG`;
  return `${e}; FG=${fgName}, BG=${bgName}; pixel values after resampling FG onto the BG grid`;
}
