/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * タイルごとのフィルタ層（LoG の派生画像の色分け重ね）の置き場。表示の状態だけで、保存しない。
 * メニューのダイアログ（画面の上位）が書き、タイル（下位）が読むので、props を何段も通さずここに置く。
 */
import { useSyncExternalStore } from "react";
import type { FilterLayer } from "./filterLayers";

const NONE: readonly FilterLayer[] = [];
const store = new Map<string, readonly FilterLayer[]>();
const listeners = new Set<() => void>();

export function getFilterLayers(tileId: string): readonly FilterLayer[] {
  return store.get(tileId) ?? NONE;
}

export function setFilterLayers(tileId: string, layers: readonly FilterLayer[]): void {
  if (layers.length === 0) store.delete(tileId);
  else store.set(tileId, layers);
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const useFilterLayers = (tileId: string): readonly FilterLayer[] =>
  useSyncExternalStore(subscribe, () => getFilterLayers(tileId));

/** テスト用。 */
export function _resetFilterLayerStore(): void {
  store.clear();
  listeners.clear();
}
