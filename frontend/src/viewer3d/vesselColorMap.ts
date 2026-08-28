/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 血管ツリーに解析値（FFR 等）を色で乗せるための純ロジック。
 * `fw/angio-design.md` §11（A7）。
 *
 * <h3>🔴 本体は値の意味を解釈しない</h3>
 * FFR を計算するのは外部モジュール（§11.1）。ここがやるのは
 * 「**モジュールが申告した範囲**を色に写す」ことだけで、閾値も正常/異常の判定も持たない。
 * 0.80 のような臨床的なカットオフを本体に埋め込むと、**モジュールが別の基準で出した値まで
 * その線で色分けされる**——本体が診断的な主張をしたことになる。
 *
 * <h3>色の向き（決めごと・画面にも書く）</h3>
 * `range[0]` を**赤**、`range[1]` を**青**に写す。FFR のように**低いほど悪い**量に合わせてある。
 * 高いほど悪い量を出すモジュールは、**同じ向きで描かれる**ので符号を反転して渡すこと
 * （本体が量ごとに向きを推測すると、推測を外したときに黙って逆の絵が出る）。
 *
 * <h3>🚨 値が無い点は色を作らない</h3>
 * モジュールが値を返さなかった点、範囲外・非有限の値は**グレー**にする。
 * 補間して埋めると、**解析されていない区間が解析済みに見える**。
 */

export type Rgb = readonly [number, number, number];

/** 値が無い点の色（グレー）。凡例にも同じ色で「値なし」を出す。 */
export const NO_VALUE_RGB: Rgb = [0.55, 0.58, 0.62];

/**
 * 赤 → 橙 → 黄 → 緑 → 青 の 5 ストップ。
 * 単調な明度変化より「どこが悪いか」の弁別を優先している（血管の細い管に乗るため）。
 */
const STOPS: readonly Rgb[] = [
  [0.85, 0.11, 0.09], // 赤
  [0.95, 0.52, 0.09], // 橙
  [0.95, 0.87, 0.15], // 黄
  [0.3, 0.76, 0.33], // 緑
  [0.15, 0.44, 0.86], // 青
];

/** 正規化値 t（0..1）→ RGB（各 0..1）。範囲外は端でクランプする。 */
export function rampColor(t: number): Rgb {
  if (!Number.isFinite(t)) return NO_VALUE_RGB;
  const u = Math.min(1, Math.max(0, t));
  const span = STOPS.length - 1;
  const pos = u * span;
  const i = Math.min(span - 1, Math.floor(pos));
  const f = pos - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * 値 → 正規化値。範囲が退化（min === max）していたら**正規化しない**で NaN を返す
 * （0 除算で全点が同じ色になるより、「色を作れなかった」と分かるほうがよい）。
 */
export function normalizeValue(value: number, range: readonly [number, number]): number {
  const [lo, hi] = range;
  if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return NaN;
  return (value - lo) / (hi - lo);
}

/**
 * 区間の点ごとの値を並べる。値の無い点は NaN。
 *
 * @param pointCount その区間の中心線点数
 * @param points     解析値（`index` は中心線の添字。範囲外は捨てる）
 */
export function segmentValues(
  pointCount: number,
  points: readonly { index: number; value: number }[],
): Float32Array {
  const out = new Float32Array(pointCount);
  out.fill(NaN);
  for (const p of points) {
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= pointCount) continue;
    if (!Number.isFinite(p.value)) continue;
    out[p.index] = p.value;
  }
  return out;
}

/**
 * 値の並び → RGB（0..255・3 成分）。値の無い点は {@link NO_VALUE_RGB}。
 */
export function valuesToRgb(values: Float32Array, range: readonly [number, number]): Uint8Array {
  const out = new Uint8Array(values.length * 3);
  for (let i = 0; i < values.length; i++) {
    const rgb = rampColor(normalizeValue(values[i], range));
    out[i * 3] = Math.round(rgb[0] * 255);
    out[i * 3 + 1] = Math.round(rgb[1] * 255);
    out[i * 3 + 2] = Math.round(rgb[2] * 255);
  }
  return out;
}

/**
 * RGB の並びを別の点数へ貼り直す（**最近傍**）。
 *
 * <h3>🚨 なぜ要るのか</h3>
 * 3D 表示は中心線を 1mm 間隔で貼り直してから管にする（`scene3d` の `sampleCenterline`）ので、
 * **解析値の添字（元の制御点）と表示点の添字は一致しない**。素通しにすると値が血管の途中で
 * ずれたまま乗り、**狭窄の位置が動いて見える**。
 *
 * <h3>🔴 線形補間にしない</h3>
 * 「値なし」のグレーと実際の色を混ぜると、**中間の色＝ありもしない値**が生まれる。
 * 最近傍なら、値のある点の色だけが伸びる。
 */
export function resampleColorsNearest(src: Uint8Array, dstCount: number): Uint8Array {
  const srcCount = Math.floor(src.length / 3);
  const out = new Uint8Array(Math.max(0, dstCount) * 3);
  if (out.length === 0) return out;
  if (srcCount === 0) {
    for (let i = 0; i < dstCount; i++) {
      out[i * 3] = Math.round(NO_VALUE_RGB[0] * 255);
      out[i * 3 + 1] = Math.round(NO_VALUE_RGB[1] * 255);
      out[i * 3 + 2] = Math.round(NO_VALUE_RGB[2] * 255);
    }
    return out;
  }
  for (let i = 0; i < dstCount; i++) {
    const t = dstCount === 1 ? 0 : i / (dstCount - 1);
    const j = Math.min(srcCount - 1, Math.round(t * (srcCount - 1)));
    out[i * 3] = src[j * 3];
    out[i * 3 + 1] = src[j * 3 + 1];
    out[i * 3 + 2] = src[j * 3 + 2];
  }
  return out;
}

/** 凡例の目盛り（下端＝range[0]・上端＝range[1]）。 */
export function legendStops(count = 16): { t: number; rgb: Rgb }[] {
  const out: { t: number; rgb: Rgb }[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    out.push({ t, rgb: rampColor(t) });
  }
  return out;
}

/** CSS の色文字列（凡例・注記用）。 */
export function cssRgb(rgb: Rgb): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])})`;
}
