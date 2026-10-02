/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D QCA ダイアログに出すプラグインのボタン（H63・面 `viewer2d.xa3d`）。
 *
 * <p>プラグインの host は `Viewer2DMenuBar` が組み立てる（`ViewerActions` を持っているのはそこだけ）が、
 * ダイアログは `SeriesViewer` の下にあって `actions` に届かない。host の組み立てを 2 か所に
 * 持つと片方だけ H## を足す事故になる（`makeViewerHost` の注記）ので、**メニューバーが作った項目を
 * ここへ置き、ダイアログはそれを読むだけ**にする。
 *
 * <p>🔑 項目の配列はメニューバーが描画されるたびに作り直される（`onClick` が最新の `actions` を
 * 掴むため）。そのたびにダイアログを描き直さないよう、**id と表示名が変わったときだけ**購読者へ
 * 知らせ、クリックは常に最新の `onClick` へ委譲する。
 */

import { useSyncExternalStore } from "react";
import type { PluginMenuItem } from "./pluginRegistry";

let latest = new Map<string, PluginMenuItem>();
let snapshot: PluginMenuItem[] = [];
const listeners = new Set<() => void>();

function sameShape(a: readonly PluginMenuItem[], b: readonly PluginMenuItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.label === b[i].label);
}

/** メニューバーが呼ぶ。 */
export function publishXa3dPluginItems(items: readonly PluginMenuItem[]): void {
  latest = new Map(items.map((it) => [it.id, it]));
  if (sameShape(snapshot, items)) return;
  snapshot = items.map((it) => ({
    id: it.id,
    label: it.label,
    onClick: () => latest.get(it.id)?.onClick(),
  }));
  for (const l of listeners) l();
}

export function getXa3dPluginItems(): PluginMenuItem[] {
  return snapshot;
}

/** ダイアログが使う。 */
export function useXa3dPluginItems(): PluginMenuItem[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getXa3dPluginItems,
    getXa3dPluginItems,
  );
}
