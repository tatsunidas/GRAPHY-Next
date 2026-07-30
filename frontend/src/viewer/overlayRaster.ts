/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグインが渡した値マップ（`ViewerOverlay`）を RGBA へ焼くための純ロジック。
 *
 * <p>色付けを本体側に置く理由: プラグインに RGBA を組ませると、W/L の意味・LUT・透明度の扱いが
 * プラグインごとにばらつき、本体の LUT 資産（`/api/luts` の 106 種）も使えない。
 * プラグインは「値」だけ渡し、見せ方は本体が決める（設計 fw/plugin-architecture.md §7 の H4a）。
 */
import type { LutData } from "../api";

/** 値 → 濃淡の窓。 */
export interface OverlayWindow {
  center: number;
  width: number;
}

/**
 * NaN を除いた min/max から窓を決める。全部 NaN / 定数のときは null。
 *
 * <p>プラグインが `window` を省略したときの既定。定数マップ（例: すべて 1 のマスク）は
 * 幅 0 になり濃淡を作れないので、呼び出し側で「一律最大濃度」として扱う。
 */
export function autoWindow(data: Float32Array): OverlayWindow | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of data) {
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity || !(max > min)) return null;
  return { center: (min + max) / 2, width: max - min };
}

/** 値 → 0..255。窓の外は飽和。窓が無い（定数マップ）ときは 255。 */
export function toGrayLevel(value: number, win: OverlayWindow | null): number {
  if (!win || !(win.width > 0)) return 255;
  const lower = win.center - win.width / 2;
  const t = (value - lower) / win.width;
  if (t <= 0) return 0;
  if (t >= 1) return 255;
  return Math.round(t * 255);
}

/**
 * 値マップを RGBA（Uint8ClampedArray, 長さ rows*cols*4）へ焼く。
 *
 * <p>`NaN` は α=0（透明）。それ以外は `opacity` をそのまま α にする（値による α 変調はしない＝
 * マスクの縁が半端に薄くならないようにする）。`lut` があれば濃淡を LUT で色に置き換える。
 */
export function rasterizeOverlay(
  data: Float32Array,
  opacity: number,
  win: OverlayWindow | null,
  lut: LutData | null,
): Uint8ClampedArray {
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
  const out = new Uint8ClampedArray(data.length * 4);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const o = i * 4;
    if (Number.isNaN(v)) {
      out[o + 3] = 0;
      continue;
    }
    const g = toGrayLevel(v, win);
    if (lut) {
      out[o] = lut.r[g];
      out[o + 1] = lut.g[g];
      out[o + 2] = lut.b[g];
    } else {
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
    }
    out[o + 3] = alpha;
  }
  return out;
}
