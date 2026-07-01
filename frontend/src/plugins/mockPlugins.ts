/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// backend の /api/plugins が未実装の間、両メニューの配線を動作確認するためのデモ。
// backend が実装され応答を返すようになったら、そちらが優先され本ファイルは不要になる。
import type { PluginManifest, PluginModule } from "./pluginTypes";

/** true の間は /api/plugins 失敗時にデモを表示する。backend 実装後は false でよい。 */
export const MOCK_ENABLED = true;

/** デモ用マニフェスト。bundleUrl 空 = 下の DEMO_MODULES をインラインで使う。 */
export const MOCK_MANIFESTS: PluginManifest[] = [
  {
    id: "demo-invert",
    name: "Demo: Invert (2D)",
    version: "0.0.0",
    frontend: { bundleUrl: "", contributes: ["viewer2d.menu"] },
  },
  {
    id: "demo-hello-main",
    name: "Demo: Hello (MainScreen)",
    version: "0.0.0",
    frontend: { bundleUrl: "", contributes: ["mainscreen.menu"] },
  },
];

/**
 * bundleUrl が空のデモ用インラインモジュール。
 * 本物のプラグインは backend が ES モジュールとして配信し、動的 import で読み込む。
 */
export const DEMO_MODULES: Record<string, PluginModule> = {
  "demo-invert": {
    activate: (host) => {
      if (host.surface === "viewer2d.menu" || host.surface === "viewer2d.toolbar") {
        host.actions.invert();
      }
    },
  },
  "demo-hello-main": {
    activate: (host) => {
      if (host.surface === "mainscreen.menu") {
        host.notify(`Plugin OK — selected study: ${host.selectedStudyUid ?? "(none)"}`);
      }
    },
  },
};
