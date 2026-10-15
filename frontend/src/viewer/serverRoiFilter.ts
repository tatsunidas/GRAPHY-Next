/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * サーバの SEG / RTSTRUCT のうち、表示中のシリーズを参照するものだけを残す。
 * backend の DTO はシリーズ UID ではなく、フレーム/輪郭ごとの参照 SOP Instance UID を返すので、
 * 表示中シリーズのインスタンス集合に含まれる参照を持つかで判定する。参照が 1 つも無いものは判定できないため除外する。
 */
interface HasRef {
  referencedSopInstanceUid: string | null;
}

export function referencesAnyOf(refs: ReadonlyArray<HasRef>, sops: ReadonlySet<string>): boolean {
  return refs.some((r) => !!r.referencedSopInstanceUid && sops.has(r.referencedSopInstanceUid));
}

/** SEG: 表示中シリーズを参照するフレームを持つ segment だけ。 */
export function filterSegSegments<S extends { frames: ReadonlyArray<HasRef> }>(
  segments: ReadonlyArray<S>,
  sops: ReadonlySet<string>,
): S[] {
  return segments.filter((s) => referencesAnyOf(s.frames, sops));
}

/** RTSTRUCT: 表示中シリーズを参照する輪郭を持つ ROI だけ。 */
export function filterRtRois<R extends { contours: ReadonlyArray<HasRef> }>(
  rois: ReadonlyArray<R>,
  sops: ReadonlySet<string>,
): R[] {
  return rois.filter((r) => referencesAnyOf(r.contours, sops));
}
