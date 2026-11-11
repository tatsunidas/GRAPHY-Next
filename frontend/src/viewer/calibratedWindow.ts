import type { SuvType } from "./suv";

/** SUV 系の臨床標準ウィンドウの上限（SUV 0〜7）。 */
const SUV_WINDOW_UPPER = 7;
/** %ID/cc は固定の臨床標準が無い（ヒトで 1e-3 オーダー、マウスで数〜数十）ので、画像の分布から決める。 */
const PID_UPPER_QUANTILE = 0.995;

/**
 * 校正を付与したときの既定ウィンドウ。返り値は voiRange のモダリティ値(Bq/mL)空間 `{lower, upper}`。
 * 校正値 = モダリティ値 × scale。
 *
 * - SUV 4 種: 校正値 0〜7（従来どおり）。
 * - %ID/cc: 校正値 0〜（表示中スライスの 99.5 百分位）。分布が使えない（値なし・上限が 0 以下）ときは最大値、
 *   それも無ければ SUV と同じ 0〜7 に戻す（真っ黒な画面を出さない）。
 *
 * @param calibratedValues 表示中スライスの校正済みの値（`readModalitySliceSync().values`）。無くてもよい。
 */
export function defaultCalibratedWindow(
  type: SuvType,
  scale: number,
  calibratedValues?: ArrayLike<number> | null,
): { lower: number; upper: number } | null {
  if (!(scale > 0)) return null;
  const fallback = { lower: 0, upper: SUV_WINDOW_UPPER / scale };
  if (type !== "pid") return fallback;
  if (!calibratedValues || calibratedValues.length === 0) return fallback;
  const finite: number[] = [];
  for (let i = 0; i < calibratedValues.length; i++) {
    const v = calibratedValues[i];
    if (Number.isFinite(v) && v > 0) finite.push(v);
  }
  if (finite.length === 0) return fallback;
  finite.sort((a, b) => a - b);
  const q = finite[Math.min(finite.length - 1, Math.floor(PID_UPPER_QUANTILE * finite.length))];
  const upper = q > 0 ? q : finite[finite.length - 1];
  return upper > 0 ? { lower: 0, upper: upper / scale } : fallback;
}
