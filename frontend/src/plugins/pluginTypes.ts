/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグイン契約の型定義。設計は fw/plugin-architecture.md を参照。
// フロント面と /api/plugins の契約は standalone / web 両モード共通。
import type { ViewerActions } from "../viewer2d/Viewer2DToolbar";
import type { PluginStoreDoc, PluginStoreSaveResult } from "./pluginStore";
import type {
  ViewerDerivedSeriesRequest,
  ViewerDerivedSeriesResult,
  ViewerOverlay,
  ViewerPixelDataOptions,
  ViewerRoiMeasurements,
  ViewerTarget,
  ViewerTilePixelData,
  ViewerTileRoi,
  ViewerTileViewState,
} from "../viewer/viewerCommands";

export type { PluginStoreDoc, PluginStoreSaveResult };

export type {
  ViewerDerivedSeriesRequest,
  ViewerDerivedSeriesResult,
  ViewerOverlay,
  ViewerPixelDataOptions,
  ViewerRoiMeasurements,
  ViewerTarget,
  ViewerTilePixelData,
  ViewerTileRoi,
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
  /**
   * ユーザーが描いた **ROI（計測・幾何注釈）を読む**（H5）。`tileId` 省略時は**対象タイル全部**
   * （ベースラインと追跡を並べて開いている場合に両方読めるようにするため。H1〜H4 の「先頭タイル」と違う）。
   * ROI が無ければ空配列。
   *
   * <p>長径・短径は**2 系統返る**（`measurements`）。Bidirectional はユーザーが軸を明示的に引くので
   * `length` / `shortAxis`（ツール値）を、楕円・矩形・自由曲線は `longAxisMm` / `shortAxisMm`
   * （形状から本体が算出＝最遠 2 点と、それに直交する広がり）を使う。**黙って片方を代入しない**。
   * 画素間隔が不明なシリーズでは算出値は `undefined`（mm を捏造しない）。
   *
   * <p>⚠ **`roiUid` はセッション内でのみ安定**である（本体に ROI の永続化が無い）。
   * 時系列で同じ病変を追うなら `sopInstanceUid` ＋ `points`（画素座標）＋プラグイン自身の ID で
   * 記録し、`roiUid` を鍵にしないこと。また `zScope === "all"`（global ROI）は
   * `sliceIndex` / `sopInstanceUid` が「いま見ているスライス」を指すだけなので、計測記録では弾くこと。
   *
   * <p>**呼ぶたびに現在値を読む**。ユーザーは ROI を編集し続けるので、活性化時の
   * スナップショットを持ち回らないこと。
   */
  getRois: (tileId?: string) => ViewerTileRoi[];
  /**
   * ROI に紐付けた**このプラグインの属性**を読む（H5）。未設定なら空オブジェクト。
   * キーは自動で `plugin.<pluginId>.` 名前空間に置かれるので、他プラグインや本体の属性とは混ざらない。
   */
  getRoiMeta: (roiUid: string) => Record<string, string>;
  /**
   * ROI に**このプラグインの属性**を書く（H5）。既存キーはマージ更新。ROI が無ければ false。
   * 例: 病変の追跡 ID・標的/非標的の区分・測定ステータス。
   *
   * <p>属性は **ROI と同じ寿命**を持つ。本体は ROI を患者単位で永続化するので、
   * アプリを再起動しても ROI と一緒に属性も戻る。ROI を消せば属性も消えるため、
   * ROI に依存しない記録（評価履歴など）は `saveStore()`（H8）に置くこと。
   */
  setRoiMeta: (roiUid: string, patch: Record<string, string>) => boolean;
  /**
   * ROI の追加・変更・削除を購読する（H5）。返り値を呼ぶと解除。
   *
   * <p>**何が変わったかは渡さない**（差分を契約にすると本体の内部表現に縛られる）。
   * 通知を受けたら `getRois()` を読み直すこと。ダイアログを閉じるときは必ず解除する。
   */
  subscribeRois: (listener: () => void) => () => void;
  /**
   * **このプラグイン専用の保存領域**を読む（H8）。患者単位・backend 保管。
   * 未保存でもエラーにならず `json: null` が返る。
   *
   * <p>`patientKey` 省略時は対象タイルの患者。プラグイン id は host が入れるので、
   * 別のプラグインの領域には触れない。
   */
  loadStore: (patientKey?: string) => Promise<PluginStoreDoc>;
  /**
   * **このプラグイン専用の保存領域**へ書く（H8）。
   *
   * <p>`version` は `loadStore()` で受け取った値をそのまま返送する規約。別ウィンドウ・別端末が
   * 先に保存していたら `{ ok: false, conflict: true }` が返るので、**読み直して統合してから**
   * 新しい版で再保存すること。単純な上書きは相手の記録を消す
   * （数か月分の評価記録が消えると取り返しがつかない）。
   *
   * <p>初回保存は `version: null`。既に保存があるのに null を送ると衝突として弾かれる
   * （読まずに上書きさせないため）。
   */
  saveStore: (
    json: string,
    opts?: { patientKey?: string; version?: number | null },
  ) => Promise<PluginStoreSaveResult>;
  /** **このプラグイン専用の保存領域**を消す（H8）。他プラグイン・本体の保存には影響しない。 */
  deleteStore: (patientKey?: string) => Promise<boolean>;
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
