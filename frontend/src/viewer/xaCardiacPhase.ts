/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 解析フレームの心位相を **ECG（R Wave Pointer (0028,6040)）だけから**出す純関数
 * （`fw/xa-confirm-ui-design.md` §4 段 1 の P2）。
 *
 * <p>画像から位相を推定しない。画像のみの推定は実データで検証できていない
 * （`fw/ffr-cases-dicom-tag-check.md`: Rubo 0002/0012 で対照が不成立、FFR 2 症例は未実施）。
 * R 波ポインタが無い撮影は {@link CardiacPhaseInfo.source} が `"none"` になり、候補も位相も出さない。
 *
 * <p>R 波ポインタは **1 起点のフレーム番号**（DICOM C.8.7.1）。内部は 0 起点で扱う。
 * R-R が不整でも、位相は**そのフレームを挟む拍の R-R**で割る。
 */

export interface CardiacPhase {
  /** 直前の R 波からの経過 [ms]。 */
  msSincePrevR: number;
  /** その拍の R-R に対する比（0 以上 1 未満）。 */
  rrFraction: number;
  /** その拍の R-R [ms]。 */
  rrMs: number;
}

export interface CardiacPhaseInfo {
  /** `"ecg"` = R 波ポインタあり／`"none"` = 無い（候補も位相も出さない）。 */
  source: "ecg" | "none";
  /** R 波のフレーム（0 起点・昇順・重複なし）。 */
  rFrames: number[];
  /** 各 R 波の直前のフレーム（0 起点）。R 波の数と同じ長さ。フレーム 0 が R 波のとき直前は無いので除く。 */
  candidates: number[];
  /** 解析フレームの位相。挟む R 波が両方そろわない（外挿になる）・ECG なしは null。 */
  phase: CardiacPhase | null;
}

/** R 波ポインタ（1 起点）を 0 起点・昇順・重複なし・範囲内に整える。範囲外は捨てる。 */
export function normalizeRWaves(pointers: readonly number[] | null, frameCount: number): number[] {
  if (!pointers) return [];
  const set = new Set<number>();
  for (const p of pointers) {
    const f = p - 1;
    if (Number.isInteger(f) && f >= 0 && f < frameCount) set.add(f);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * @param pointers   R Wave Pointer の値（1 起点）。タグ無しは null
 * @param frameTimes 各フレームの開始時刻 [ms]（`frameStartTimesMs`）
 * @param frame      解析したフレーム（0 起点）
 */
export function cardiacPhaseInfo(
  pointers: readonly number[] | null,
  frameTimes: readonly number[],
  frame: number,
): CardiacPhaseInfo {
  const rFrames = normalizeRWaves(pointers, frameTimes.length);
  if (rFrames.length === 0) return { source: "none", rFrames: [], candidates: [], phase: null };

  const candidates = rFrames.filter((r) => r > 0).map((r) => r - 1);

  let phase: CardiacPhase | null = null;
  const nextIdx = rFrames.findIndex((r) => r > frame);
  if (nextIdx > 0) {
    const prev = rFrames[nextIdx - 1];
    const next = rFrames[nextIdx];
    const rrMs = frameTimes[next] - frameTimes[prev];
    if (rrMs > 0) {
      const ms = frameTimes[frame] - frameTimes[prev];
      phase = { msSincePrevR: ms, rrFraction: ms / rrMs, rrMs };
    }
  }
  return { source: "ecg", rFrames, candidates, phase };
}
