/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグイン契約の型定義。設計は fw/plugin-architecture.md を参照。
// フロント面と /api/plugins の契約は standalone / web 両モード共通。
import type { ViewerActions } from "../viewer2d/Viewer2DToolbar";
import type {
  ViewerDerivedSeriesRequest,
  ViewerDerivedSeriesResult,
  ViewerOverlay,
  ViewerPixelDataOptions,
  ViewerTarget,
  ViewerTilePixelData,
  ViewerTileViewState,
} from "../viewer/viewerCommands";

export type {
  ViewerDerivedSeriesRequest,
  ViewerDerivedSeriesResult,
  ViewerOverlay,
  ViewerPixelDataOptions,
  ViewerTarget,
  ViewerTilePixelData,
  ViewerTileViewState,
};

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
  /**
   * 操作対象タイルが「いま何を表示しているか」（fw/plugin-architecture.md §7 の H1）。
   *
   * <p>対象は `actions` の各コマンドと同一定義（選択タイル→無ければ全タイル）。
   * **呼ぶたびに現在値を読む関数**である点に注意: プラグインがダイアログを開いたまま
   * ユーザーがスライスを送ることがあるため、活性化時のスナップショットを配ってはいけない。
   */
  getTargets: () => ViewerTarget[];
  /**
   * 対象タイルの表示状態（H2）。`tileId` 省略時は対象の先頭タイル。取得不能なら null。
   * W/L はモダリティ値空間（CT なら HU）。単位は `unit`。
   */
  getViewState: (tileId?: string) => ViewerTileViewState | null;
  /**
   * 対象タイルのスライス 1 枚の**校正済み画素**（H3）。`tileId` 省略時は対象の先頭タイル。
   * 取得不能・`sliceIndex` が範囲外なら null。
   *
   * <p>値はモダリティ値（CT なら HU、SUV 校正済み PET なら SUV。単位は `unit`）で、
   * **表示 W/L は掛かっていない**＝定量処理に使える。カラー画像は輝度で `unit="raw"`。
   *
   * <p>1 回 1 スライス。シリーズ全体が要るなら `sliceIndex` を変えて回すこと
   * （512×512×500 で Float32 なら 500MB を超えるので、必要な範囲だけ読む設計にする）。
   *
   * <p>⚠ これは患者の生画素をプラグインへ渡す API である。プラグインは本体と同じ権限で動くため
   * （`plugin-manager-design.md` §8 の P3 サンドボックスは未実装）、**強制はまだ無い**。
   * 使うプラグインは `plugin.json` の `permissions` に `read-pixels` を宣言すること
   * （導入時の同意画面に表示される）。
   */
  getPixelData: (tileId?: string, opts?: ViewerPixelDataOptions) => Promise<ViewerTilePixelData | null>;
  /**
   * 処理結果（値マップ）を対象タイルの**表示中スライスへ重ねて見せる**（H4a）。
   * `tileId` 省略時は対象の先頭タイル。rows/cols が現在スライスと不一致なら false。
   *
   * <p>プラグインは**値だけ**渡し、色付け（window / LUT / 不透明度）は本体が行う。
   * `NaN` の画素は透明になるので、マスクや部分的なマップをそのまま渡せる。
   * 出所が分かるように、本体が画像の左下にプラグイン名のラベルを出す。
   *
   * <p>オーバーレイは**出したスライスに紐付く**（他スライスでは自動的に隠れ、戻ると再表示。
   * シリーズ / C・T 切替では破棄）。**これは表示だけ**で保存はしない。
   * 保管庫 / PACS へ残すなら `saveDerivedSeries()`（H4b）を使う。
   */
  showOverlay: (tileId: string | undefined, overlay: ViewerOverlay) => boolean;
  /** プラグインオーバーレイを消す（H4a）。`tileId` 省略時は対象タイル全部。 */
  clearOverlay: (tileId?: string) => void;
  /**
   * 処理結果を**派生シリーズとして保存する**（H4b）。standalone はローカル保管庫、
   * web は外部 PACS（STOW-RS）へ書き戻す。
   *
   * <p>**本体が必ず確認ダイアログを出す**（抑止不可）。ユーザーが拒否すると
   * `{ ok: false, cancelled: true }` が返る。プラグインが黙って保存することはできない。
   *
   * <p>**幾何はプラグインに書かせない**: 各フレームは「元シリーズのどのスライスに対応するか」
   * （`sliceIndex`）だけを申告し、IPP / IOP / PixelSpacing / スライス厚は本体が元シリーズから
   * 引き継ぐ。`rows`/`cols` は元スライスと一致していること。
   *
   * <p>画素は Float32 → 16bit signed ＋ Rescale で保存される（HU のような整数はそのまま、
   * 確率マップのような小さい実数は値域から係数を決めて量子化）。**`NaN` を含むなら `background`
   * が必須**（未指定は拒否。指定値は `PixelPaddingValue` にも書かれる）。
   * 保存されたシリーズは `SeriesDescription` に `[Plugin] ` 接頭辞が付き、
   * `DerivationDescription` / `ContributingEquipmentSequence` にプラグイン id・版が記録される。
   */
  saveDerivedSeries: (
    tileId: string | undefined,
    req: ViewerDerivedSeriesRequest,
  ) => Promise<ViewerDerivedSeriesResult>;
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
