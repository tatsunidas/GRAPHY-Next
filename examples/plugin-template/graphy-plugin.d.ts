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

/**
 * 操作対象タイル 1 枚が「いま何を表示しているか」。`host.getTargets()` の要素。
 *
 * <p>**GRAPHY-Next 0.1.9 以降**。使うプラグインは plugin.json の
 * `engines.graphy` を `">=0.1.9"` にすること（古い本体には導入させない＝正しい挙動）。
 */
export interface ViewerTarget {
  /** タイルの識別子。`getViewState(tileId)` に渡せる。 */
  tileId: string;
  studyUid: string;
  seriesUid: string;
  /** 画面に出ているシリーズ名。 */
  seriesLabel: string;
  /** 表示中スライスの imageId。 */
  imageId: string;
  /** 表示中スライス（Z）の 0 始まり index と、そのスタックの総数。 */
  sliceIndex: number;
  sliceCount: number;
  /** ZCT モデルのチャンネル / 時相（多次元でないシリーズは 0）。 */
  c: number;
  t: number;
  modality: string;
}

/**
 * タイル 1 枚の表示状態。`host.getViewState()` の戻り。
 *
 * <p>W/L は**モダリティ値空間**（CT なら HU）。表示単位は `unit`。**0.1.9 以降**。
 */
export interface ViewerViewState {
  tileId: string;
  windowCenter: number;
  windowWidth: number;
  /** 校正済み画素値の単位（CT は "HU"、無ければ ""）。 */
  unit: string;
  /** 適用中の LUT 名（LUT ダイアログの名前。例 "10_Percent"）。グレースケール（未適用）なら null。 */
  colormap: string | null;
  invert: boolean;
  flipH: boolean;
  flipV: boolean;
  /** 度。 */
  rotation: number;
  /** Fit を 1.0 とした相対倍率。 */
  zoom: number;
  /** 既定（画像が中央）からのオフセット（world mm）。 */
  pan: [number, number];
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
  /**
   * 操作対象タイル（選択タイル→無ければ全タイル。`actions` の対象と同じ）が
   * いま何を表示しているか。**0.1.9 以降**。
   *
   * <p>**呼ぶたびに現在値を読む**。ダイアログを開いている間にユーザーがスライスを送ることが
   * あるので、活性化時に一度だけ読んだ値を持ち回らないこと。
   */
  getTargets: () => ViewerTarget[];
  /**
   * 対象タイルの表示状態。`tileId` を省略すると対象の先頭タイル。取得不能なら null。
   * **0.1.9 以降**。
   */
  getViewState: (tileId?: string) => ViewerViewState | null;
}

/** MainScreen 系（mainscreen.menu）に渡るコンテキスト。 */
export interface MainScreenPluginHost extends PluginHostBase {
  surface: "mainscreen.menu";
  /** 選択中スタディの UID（未選択なら null）。 */
  selectedStudyUid: string | null;
}

export type PluginHost = Viewer2DPluginHost | MainScreenPluginHost;
