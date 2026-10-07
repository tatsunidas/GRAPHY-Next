/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * W/L 調整の刻みと表示の桁。CT（整数・数千の幅）と ADC（float・0.001 の幅）の両方で使えるように、
 * 固定の 1 や 0.1 ではなく画像の値域から決める。
 */

/**
 * 幅の下限。整数の画像は 1 段（モダリティ値の 1 を表示空間へ換算した `unitStep`）、
 * 非整数の画像はスライダー 1 目盛り分（値域 / 目盛り数）。値域が 0 なら値の大きさに対する機械精度。
 */
export function minWindowWidth(
  integral: boolean,
  dataMin: number,
  dataMax: number,
  unitStep: number,
  sliderSteps: number,
): number {
  if (integral) return unitStep;
  const range = dataMax - dataMin;
  if (range > 0) return range / sliderSteps;
  return Number.EPSILON * Math.max(1, Math.abs(dataMax));
}

/** 刻み `step` が見分けられる小数の桁数（少なくとも 1 桁＝今までの CT の表示と同じ）。 */
export function decimalsFor(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 1;
  return Math.min(12, Math.max(1, Math.ceil(-Math.log10(step))));
}

export function roundTo(v: number, decimals: number): number {
  return Number(v.toFixed(decimals));
}
