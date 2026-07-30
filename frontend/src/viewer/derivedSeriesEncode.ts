/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグインの値マップ（Float32）を派生シリーズの画素（16bit signed ＋ Rescale）へ符号化する。
 * 設計: fw/plugin-architecture.md §7 の H4b。
 *
 * <p>既存の派生シリーズ経路（`POST /api/series/derived`）は **16bit signed ＋ Rescale 恒等**を前提に
 * 作られている（Slicer のリスライスは HU がそのまま入るため恒等でよい）。しかしプラグインの出力は
 * 確率マップ（0〜1）やテクスチャ特徴量のような**小さい実数**もあり、恒等で丸めると 0/1 に潰れる。
 * そこで**値域から Rescale Slope/Intercept を決めて量子化**し、`value = stored * slope + intercept`
 * で復元できるようにする。
 *
 * <p>HU のような「もともと整数で Int16 に収まる」値はそのまま入れたい（余計な量子化誤差を足さない）ので、
 * その場合は恒等を選ぶ。
 *
 * <p><b>`NaN`（データ無し）の扱い</b>: 保存する画素に「透明」は無いので、呼び出し側が
 * `background` を明示する。**既定値は用意しない**: かつて「有効値の最小値」を既定にしていたが、
 * 閾値マスク（有効値がすべて閾値以上）では**背景が閾値そのものの値になり**、
 * 「何も無い場所」が骨と同程度の HU を持つ誤ったシリーズが出来た（実機で発生）。
 * 明示を必須にし、その値は DICOM の `PixelPaddingValue` としても書く。
 */

/** Int16 の表現範囲。 */
const INT16_MIN = -32768;
const INT16_MAX = 32767;
/** 量子化に使う段数（両端を余らせて丸め誤差で溢れないようにする）。 */
const QUANT_STEPS = 65534;

export interface EncodedFrames {
  /** フレームごとの Int16 画素（row-major、入力と同じ順）。 */
  frames: Int16Array[];
  /** `value = stored * slope + intercept`。 */
  slope: number;
  intercept: number;
  /** 恒等（量子化していない）か。 */
  identity: boolean;
  /** `NaN` を埋めた背景の**格納値**（DICOM の PixelPaddingValue に書く）。背景が無ければ null。 */
  paddingStored: number | null;
}

/** 非有限（NaN / Infinity）の画素が 1 つでもあるか。`background` の要否判定に使う。 */
export function hasNonFinite(frames: Float32Array[]): boolean {
  for (const f of frames) {
    for (const v of f) {
      if (!Number.isFinite(v)) return true;
    }
  }
  return false;
}

/** NaN・Infinity を除いた値域。有効値が無ければ null。 */
export function finiteRange(frames: Float32Array[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const f of frames) {
    for (const v of f) {
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min === Infinity ? null : { min, max };
}

/** すべての有効値が整数か（HU 等の判定）。 */
function allIntegral(frames: Float32Array[]): boolean {
  for (const f of frames) {
    for (const v of f) {
      if (!Number.isFinite(v)) continue;
      if (!Number.isInteger(v)) return false;
    }
  }
  return true;
}

/**
 * 値域から Rescale 係数を決める。純関数（テスト対象）。
 *
 * - 有効値が無い／定数マップ → 恒等（定数は量子化しても意味が無い）
 * - 整数かつ Int16 に収まる → **恒等**（HU をそのまま保つ）
 * - それ以外 → `[min, max]` を Int16 全域へ線形写像
 */
export function chooseRescale(
  range: { min: number; max: number } | null,
  integral: boolean,
): { slope: number; intercept: number; identity: boolean } {
  if (!range || !(range.max > range.min)) {
    return { slope: 1, intercept: 0, identity: true };
  }
  if (integral && range.min >= INT16_MIN && range.max <= INT16_MAX) {
    return { slope: 1, intercept: 0, identity: true };
  }
  const slope = (range.max - range.min) / QUANT_STEPS;
  // stored = round((value - min) / slope) + INT16_MIN → value = stored * slope + intercept
  const intercept = range.min - INT16_MIN * slope;
  return { slope, intercept, identity: false };
}

/**
 * 値マップ群 → Int16 画素 ＋ Rescale 係数。
 *
 * <p>`NaN` の画素は `background` で埋める（呼び出し側が明示する。`hasNonFinite()` が true なのに
 * 未指定なら、そもそも保存要求を拒否するのが正しい＝`Viewer2D.validateDerivedSeries`）。
 * 背景は**値域に含めて**係数を決めるので、背景自身も必ず表現できる。
 *
 * @param background `NaN` を埋める値。省略時は 0（非有限が無いときのみ意味を持たない）
 */
export function encodeFrames(frames: Float32Array[], background?: number): EncodedFrames {
  const fill = Number.isFinite(background) ? (background as number) : 0;
  const base = finiteRange(frames);
  // 背景も格納するので値域に含める（含めないと背景が飽和して別の値に化ける）。
  const range = base
    ? { min: Math.min(base.min, fill), max: Math.max(base.max, fill) }
    : { min: fill, max: fill };
  const integral = allIntegral(frames) && Number.isInteger(fill);
  const { slope, intercept, identity } = chooseRescale(range, integral);
  const store = (v: number) => {
    const stored = identity ? Math.round(v) : Math.round((v - intercept) / slope);
    return stored < INT16_MIN ? INT16_MIN : stored > INT16_MAX ? INT16_MAX : stored;
  };
  const out = frames.map((f) => {
    const dst = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      dst[i] = store(Number.isFinite(f[i]) ? f[i] : fill);
    }
    return dst;
  });
  return {
    frames: out,
    slope,
    intercept,
    identity,
    paddingStored: hasNonFinite(frames) ? store(fill) : null,
  };
}

/** Int16Array → Base64（リトルエンディアン）。backend の `Frame.pixels` 形式。 */
export function framePixelsBase64(pixels: Int16Array): string {
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  let s = "";
  // 引数個数の上限に当たらないようチャンクで詰める（512×512 で 512KB になるため）。
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
