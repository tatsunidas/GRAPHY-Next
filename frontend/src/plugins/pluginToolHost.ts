/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 2D 窓がアシスタントからのプラグインツール呼び出しに使うホストの素。メニューバー（makeViewerHost を持つ）が
// 描画のたびに登録する。登録が無い（メニューバーがまだ無い）ときはツールを実行しない。
import type { PluginHostSeed, PluginManifest } from "./pluginTypes";

let factory: ((m: PluginManifest) => PluginHostSeed) | null = null;

export function setPluginToolHostSeed(f: ((m: PluginManifest) => PluginHostSeed) | null): void {
  factory = f;
}

export function getPluginToolHostSeed(): ((m: PluginManifest) => PluginHostSeed) | null {
  return factory;
}
