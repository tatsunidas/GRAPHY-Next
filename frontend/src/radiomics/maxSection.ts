/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** ROI の最大断面（backend: MaxSectionService.Result）の表示用の整形。 */
import type { MaxSectionResult, MaxSectionSlice } from "../api";

/** 位置は符号つき・小数 1 桁（mm）。−0.0 は 0.0 にする。 */
export function formatPositionMm(v: number): string {
  const r = Math.round(v * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1);
}

export function formatAreaMm2(v: number): string {
  return (Math.round(v * 100) / 100).toFixed(2);
}

/** 同面積のスライスが複数あるときの、位置の並び（"−35.0, −31.0 mm"）。1 枚なら空文字。 */
export function tiePositions(r: MaxSectionResult): string {
  if (r.ties.length <= 1) return "";
  return r.ties.map((s: MaxSectionSlice) => formatPositionMm(s.positionMm)).join(", ");
}
