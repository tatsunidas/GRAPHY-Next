/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { PluginMenuItem } from "./pluginRegistry";

/**
 * 2D ビューアのプラグイン項目を、出す場所ごとに分ける。
 *
 * <p>`category: "ai"` は宣言したサーフェス（「プラグイン」でも「解析」でも）に関わらず
 * 「解析 ＞ AI ▸」1 か所にまとめる。AI が増えてもメニューが伸び続けないようにするため。
 * 両方のサーフェスを宣言したプラグインは AI に 1 回だけ出す（host の中身は同じ）。
 */
export function groupViewerPluginItems(
  pluginItems: PluginMenuItem[],
  analysisItems: PluginMenuItem[],
): { plugins: PluginMenuItem[]; analysis: PluginMenuItem[]; ai: PluginMenuItem[] } {
  const ai: PluginMenuItem[] = [];
  const seen = new Set<string>();
  for (const p of [...analysisItems, ...pluginItems]) {
    if (p.category !== "ai" || seen.has(p.id)) continue;
    seen.add(p.id);
    ai.push(p);
  }
  return {
    plugins: pluginItems.filter((p) => p.category !== "ai"),
    analysis: analysisItems.filter((p) => p.category !== "ai"),
    ai,
  };
}
