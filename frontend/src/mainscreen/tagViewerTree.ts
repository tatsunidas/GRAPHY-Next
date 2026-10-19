/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { Instance, Series, Study } from "../api";

/** タグビューアの左ツリーに出す 1 シリーズ。 */
export interface TagTreeSeries {
  study: Study;
  series: Series;
  instances: Instance[];
}

/** ツリーで一度に描くインスタンス行の数（数百枚のシリーズでも重くしない）。 */
export const TREE_WINDOW = 50;

/** `sop` が `instances` にあればそれ、無ければ（または未指定なら）先頭。インスタンスが無ければ null。 */
export function resolveInitialSop(instances: Instance[], sop?: string | null): string | null {
  if (sop && instances.some((i) => i.sopInstanceUid === sop)) return sop;
  return instances[0]?.sopInstanceUid ?? null;
}

/**
 * `focus` 番目を含む `size` 行の窓 [start, end)。端では詰める（窓は常に size 行、全体が size 以下なら全部）。
 * `focus` が範囲外・負なら先頭の窓。
 */
export function instanceWindow(count: number, focus: number, size = TREE_WINDOW): { start: number; end: number } {
  if (count <= size) return { start: 0, end: Math.max(0, count) };
  const f = focus >= 0 && focus < count ? focus : 0;
  const start = Math.min(Math.max(0, f - Math.floor(size / 2)), count - size);
  return { start, end: start + size };
}

/** 窓を `delta` 行ずらす（端で止める）。 */
export function shiftWindow(count: number, start: number, delta: number, size = TREE_WINDOW): number {
  return Math.min(Math.max(0, start + delta), Math.max(0, count - size));
}

/** ツリーとヘッダに出す、インスタンスの短い表示（`#番号 · SOP 末尾 8 桁`）。 */
export function instanceLabel(i: Instance): string {
  return `#${i.instanceNumber ?? "-"} · …${i.sopInstanceUid.slice(-8)}`;
}
