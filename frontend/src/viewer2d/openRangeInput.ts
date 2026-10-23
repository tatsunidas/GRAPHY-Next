/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 「範囲を指定して開く」ダイアログの入力 → {@link ZRange} の変換。
 *
 * <p>ダイアログ本体（.tsx）は vitest の対象外なので、判定はここ（純関数）に置く。
 * 番号は 1 origin の入力で、`parseSliceRange` が 0 origin に直す。
 */
import { parseSliceRange } from "../mainscreen/sliceRange";
import type { SeriesLayout } from "../viewer/seriesLayout";
import { contiguousSpan, positionsMm, rangeFromIndices, restrictLayout, type ZRange } from "../viewer/virtualLayout";

export type OpenRangeInput =
  | { method: "index"; text: string }
  | { method: "mm"; fromMm: string; toMm: string };

export type OpenRangeFailure =
  | "empty"        // 未入力
  | "unreadable"   // 読めない断片がある
  | "outOfRange"   // シリーズの範囲外
  | "notContiguous" // 飛び飛び
  | "noIpp"        // IPP が無いのに mm 指定
  | "noMatch";     // 区間に入るスライスが無い

export type OpenRangeResult =
  | { ok: true; range: ZRange; count: number }
  | { ok: false; reason: OpenRangeFailure; detail?: string };

export function resolveOpenRange(layout: SeriesLayout, input: OpenRangeInput): OpenRangeResult {
  if (input.method === "index") {
    if (!input.text.trim()) return { ok: false, reason: "empty" };
    const parsed = parseSliceRange(input.text, layout.nZ);
    if (parsed.invalid.length > 0) {
      // 上限超え・0 番は parseSliceRange が invalid に入れる。数字だけの断片は「範囲外」、それ以外は「読めない」。
      const numeric = parsed.invalid.every((f) => /^\d+(\s*-\s*\d+)?$/.test(f));
      return { ok: false, reason: numeric ? "outOfRange" : "unreadable", detail: parsed.invalid.join(", ") };
    }
    const span = contiguousSpan(parsed.indices);
    if (!span) return { ok: false, reason: parsed.indices.length === 0 ? "outOfRange" : "notContiguous" };
    const range = rangeFromIndices(layout, span.from, span.to);
    if (!range) return { ok: false, reason: "outOfRange" };
    return { ok: true, range, count: span.to - span.from + 1 };
  }
  if (!input.fromMm.trim() || !input.toMm.trim()) return { ok: false, reason: "empty" };
  const fromMm = Number(input.fromMm);
  const toMm = Number(input.toMm);
  if (!Number.isFinite(fromMm) || !Number.isFinite(toMm)) return { ok: false, reason: "unreadable" };
  if (!positionsMm(layout)) return { ok: false, reason: "noIpp" };
  const range: ZRange = { kind: "mm", fromMm: Math.min(fromMm, toMm), toMm: Math.max(fromMm, toMm) };
  const r = restrictLayout(layout, range);
  if (!r.ok) return { ok: false, reason: r.reason === "outOfRange" ? "outOfRange" : "noMatch" };
  return { ok: true, range, count: r.keptZ.length };
}
