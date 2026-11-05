/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 値のスケールバー（現在の W/L 窓をカラーバーで示す）の純ロジック。描画（canvas）は Viewer2D 側。
 */

/** 保存する localStorage のキー（全タイル一括の ON/OFF）。 */
export const SCALE_BAR_KEY = "graphy.viewer.scaleBar";

/** スケールバー列の固定幅(px)。ON のタイルは LUT・単位・桁数に関わらず同じ幅を確保し、画像領域の大きさを揃える。 */
export const SCALE_BAR_WIDTH = 56;

/** 保存値 → ON/OFF。`"1"` だけが ON で、欠損・不正値は既定の OFF（読めなくても従来の見た目に戻る）。 */
export function parseScaleBarSetting(raw: string | null | undefined): boolean {
  return raw === "1";
}

export function serializeScaleBarSetting(on: boolean): string {
  return on ? "1" : "0";
}

/**
 * カーソル位置のモダリティ値を表示用に整形する。
 * CT の HU（整数近傍・大きい値）は整数表示、テクスチャマップ等の<b>小さな小数（例 1e-5）は切り捨てず</b>
 * 有効桁で表示、極端に小さい/大きい値は指数表記にする。
 */
export function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(3); // 例 1.000e-5
  const digits = a >= 100 ? 1 : a >= 1 ? 3 : 6;
  const s = v.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s; // 末尾ゼロを除去
}

/** W/L 窓の下端・上端。窓幅が正でない／非有限なら NaN（ラベルは「—」になる。0 を捏造しない）。 */
export function scaleBarRange(windowCenter: number, windowWidth: number): { min: number; max: number } {
  if (!Number.isFinite(windowCenter) || !Number.isFinite(windowWidth) || !(windowWidth > 0)) {
    return { min: NaN, max: NaN };
  }
  return { min: windowCenter - windowWidth / 2, max: windowCenter + windowWidth / 2 };
}

/** 上端・下端のラベル。小さな値域（例 0.0007）を 0.0 に潰さないよう `fmtValue` を使う。 */
export function scaleBarLabels(windowCenter: number, windowWidth: number): { max: string; min: string } {
  const r = scaleBarRange(windowCenter, windowWidth);
  return { max: fmtValue(r.max), min: fmtValue(r.min) };
}

export interface ScaleBarLut {
  r: number[];
  g: number[];
  b: number[];
}

/**
 * バーの 256 色（上→下）。上が最大値。LUT 無しはグレースケール。
 * 階調反転では Cornerstone が LUT 参照の向きを逆にするので、並びも逆にする。
 */
export function scaleBarColors(lut: ScaleBarLut | null, invert: boolean): string[] {
  const out: string[] = [];
  for (let row = 0; row < 256; row++) {
    const idx = invert ? row : 255 - row;
    const r = lut ? lut.r[idx] : idx;
    const g = lut ? lut.g[idx] : idx;
    const b = lut ? lut.b[idx] : idx;
    out.push(`rgb(${r},${g},${b})`);
  }
  return out;
}
