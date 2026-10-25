/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 全患者モードのタイルの表示順（タイル ID の並び）。表示だけの順序で、患者のデータ（patients）は書き換えない。
 */

/** 順序を、実在するタイルに合わせる。無いものは外し、新しいタイルは `tileIds` の順で末尾に足す。 */
export function reconcileOrder(order: readonly string[], tileIds: readonly string[]): string[] {
  const present = new Set(tileIds);
  const kept = order.filter((id) => present.has(id));
  const have = new Set(kept);
  return [...kept, ...tileIds.filter((id) => !have.has(id))];
}

/** 2 枚の位置を入れ替える。どちらかが無い・同じなら変えない。 */
export function swapOrder(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0 || i === j) return [...order];
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** `target` の前（または後ろ）へ `id` を移す。`id` が既にあれば元の位置から外す。`target` が無ければ末尾へ。 */
export function placeNear(order: readonly string[], id: string, target: string, before: boolean): string[] {
  const rest = order.filter((x) => x !== id);
  const t = rest.indexOf(target);
  if (t < 0) return [...rest, id];
  rest.splice(before ? t : t + 1, 0, id);
  return rest;
}

/** タイル ID が変わったとき（範囲の変更）、順序上の位置を保ったまま付け替える。 */
export function renameInOrder(order: readonly string[], from: string, to: string): string[] {
  return order.map((x) => (x === from ? to : x));
}
