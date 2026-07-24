/**
 * GRAPHY-Next プラグイン UI の型定義（第三者プラグイン開発者向け・エディタ補完用）。
 *
 * この .d.ts は「ビルド不要」でエディタ型補完を得るためのもの。`ui.js` の先頭で
 *   /// <reference path="./graphy-plugin.d.ts" />
 *   // @ts-check
 * を書けば、TypeScript を導入しなくても VS Code 等で `host` に補完が効く。
 *
 * 本体の契約は GRAPHY-Next の frontend/src/plugins/pluginTypes.ts。ここはその安定サブセット。
 * 設計: fw/plugin-architecture.md §2.1 / fw/plugin-manager-design.md。
 */

/** プラグインを組み込む先（UI サーフェス）。 */
export type PluginSurface = "viewer2d.menu" | "viewer2d.toolbar" | "mainscreen.menu";

/**
 * 2D Viewer プラグインから使える表示中タイルへの操作（安定サブセット）。
 * GRAPHY-Next 側にはこれ以外の操作もあるが、ここではプラグイン向けに安定なものだけを公開する。
 */
export interface ViewerActions {
  /** 表示を Fit（はみ出しなく収める）。 */
  fit(): void;
  /** 表示状態をリセット。 */
  reset(): void;
  /** 90 度回転。 */
  rotate90(): void;
  /** 左右反転。 */
  flipH(): void;
  /** 上下反転。 */
  flipV(): void;
  /** 白黒反転。 */
  invert(): void;
  /** 元に戻す / やり直し。 */
  undo(): void;
  redo(): void;
  /** ウィンドウレベル（中心・幅）を適用。 */
  setWindowLevel(center: number, width: number): void;
  /** DICOM 既定のウィンドウに戻す。 */
  resetWindow(): void;
}

interface PluginHostBase {
  /** 自分の plugin.json の id。 */
  pluginId: string;
  /** i18n 取得関数（ホスト言語に追従）。 */
  t: (key: string) => string;
  /** ユーザーへの簡易通知。 */
  notify: (message: string) => void;
  /** バックエンド面（Java 実装）を呼ぶ: POST /api/plugins/{id}/run。standalone のみ実行可。 */
  runBackend: (payload?: unknown) => Promise<unknown>;
}

/** 2D Viewer 系（viewer2d.menu / viewer2d.toolbar）に渡るコンテキスト。 */
export interface Viewer2DPluginHost extends PluginHostBase {
  surface: "viewer2d.menu" | "viewer2d.toolbar";
  /** 表示中タイルへの操作。 */
  actions: ViewerActions;
}

/** MainScreen 系（mainscreen.menu）に渡るコンテキスト。 */
export interface MainScreenPluginHost extends PluginHostBase {
  surface: "mainscreen.menu";
  /** 選択中スタディの UID（未選択なら null）。 */
  selectedStudyUid: string | null;
}

export type PluginHost = Viewer2DPluginHost | MainScreenPluginHost;
