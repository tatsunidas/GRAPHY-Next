/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグイン契約の型定義。設計は fw/plugin-architecture.md を参照。
// フロント面と /api/plugins の契約は standalone / web 両モード共通。
import type { ViewerActions } from "../viewer2d/Viewer2DToolbar";

/** プラグインを組み込む先（UI サーフェス）。fw/plugin-architecture.md §2.1。 */
export type PluginSurface = "viewer2d.menu" | "viewer2d.toolbar" | "mainscreen.menu";

/** backend の GET /api/plugins が返すマニフェスト 1 件。 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** フロント面（UI バンドル）。UI を持たない純計算プラグインでは省略可。 */
  frontend?: {
    /** ES モジュールの配信 URL（例 /api/plugins/{id}/ui.js）。相対なら apiBase を前置。 */
    bundleUrl: string;
    /** 出す先のサーフェス。 */
    contributes: PluginSurface[];
  };
  /** バックエンド面（Java 実装）。UI 完結プラグインでは省略可。 */
  backend?: {
    entrypoint: string;
    permissions?: string[];
  };
}

interface PluginHostBase {
  pluginId: string;
  /** i18n 取得関数（プラグイン UI がホスト言語に追従できるよう渡す）。 */
  t: (key: string) => string;
  /** ユーザーへの簡易通知。 */
  notify: (message: string) => void;
  /** backend 面の実行: POST /api/plugins/{id}/run。 */
  runBackend: (payload?: unknown) => Promise<unknown>;
}

/** 2D Viewer 系プラグイン（viewer2d.menu / viewer2d.toolbar）に渡すコンテキスト。 */
export interface Viewer2DPluginHost extends PluginHostBase {
  surface: "viewer2d.menu" | "viewer2d.toolbar";
  /** 表示中タイルへの操作（既存の runViewerCommand 経由）。 */
  actions: ViewerActions;
}

/** MainScreen 系プラグイン（mainscreen.menu）に渡すコンテキスト。 */
export interface MainScreenPluginHost extends PluginHostBase {
  surface: "mainscreen.menu";
  /** 選択中スタディの UID（未選択なら null）。 */
  selectedStudyUid: string | null;
}

export type PluginHost = Viewer2DPluginHost | MainScreenPluginHost;

/**
 * プラグイン UI バンドル（ES モジュール）が公開する契約。
 * `export function activate(host) {}` または default export で `{ activate }`。
 */
export interface PluginModule {
  activate(host: PluginHost): void | Promise<void>;
}
