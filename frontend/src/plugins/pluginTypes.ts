/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグイン契約の型定義。設計は fw/plugin-architecture.md を参照。
// フロント面と /api/plugins の契約は standalone / web 両モード共通。
import type { ViewerActions } from "../viewer2d/Viewer2DToolbar";
import type { PluginStoreDoc, PluginStoreSaveResult } from "./pluginStore";
import type { PluginWindowHandle, PluginWindowOptions } from "./pluginWindowApi";
import type {
  PluginValueVolume,
  PluginViewportHandle,
  PluginViewportOptions,
  PluginVolumeViewHandle,
  PluginVolumeViewMode,
} from "./pluginViewportApi";
import type { PluginMaskInput, PluginMeshMeasurement, PluginMeshOptions } from "./pluginMeshApi";
import type { PluginSeriesPanelHandle, PluginSeriesPanelOptions } from "./pluginSeriesPanelApi";
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
  ViewerSrMeasurementGroup,
  ViewerSrRequest,
  ViewerSrResult,
} from "../viewer/viewerCommands";

export type { PluginStoreDoc, PluginStoreSaveResult };

export type { PluginWindowHandle, PluginWindowOptions } from "./pluginWindowApi";
export type {
  PluginValueVolume,
  PluginViewportHandle,
  PluginViewportOptions,
  PluginVolumeViewHandle,
  PluginVolumeViewMode,
} from "./pluginViewportApi";
export type { PluginMaskInput, PluginMeshMeasurement, PluginMeshOptions } from "./pluginMeshApi";
export type { PluginSeriesPanelHandle, PluginSeriesPanelOptions } from "./pluginSeriesPanelApi";

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
  ViewerSrMeasurementGroup,
  ViewerSrRequest,
  ViewerSrResult,
};

/**
 * プラグインを組み込む先（UI サーフェス）。fw/plugin-architecture.md §2.1。
 *
 * <p>`viewer2d.menu.analysis` は **2D ビューアの「解析」メニュー**に出す
 * （`viewer2d.menu` ＝「プラグイン」メニューとは別）。本体の解析機能と並ぶ位置に出るため、
 * **プラグイン由来であることの表示が必須**（区切り線 ＋ 印。`fw/subtraction-design.md` §15.8）。
 * host の中身は `viewer2d.menu` と完全に同一で、違うのは出る場所だけである。
 */
export type PluginSurface =
  | "viewer2d.menu"
  | "viewer2d.menu.analysis"
  | "viewer2d.toolbar"
  | "mainscreen.menu";

/** 2D ビューア系サーフェス（host の形が同じもの）。 */
export type Viewer2DSurface = "viewer2d.menu" | "viewer2d.menu.analysis" | "viewer2d.toolbar";

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
  /**
   * いまの表示言語（`"ja"` / `"en"`）。**プラグインが自前の文言を持つ場合の言語判定に使う**
   * （`t()` は本体のキーしか引けない）。
   *
   * <p>**値は活性化した時点のもの**。プラグインの UI は本体の React ツリーの外にあるため、
   * 途中で言語を切り替えても自動では追従しない（切り替えたらプラグインを開き直す）。
   */
  locale: string;
  /** ユーザーへの簡易通知。 */
  notify: (message: string) => void;
  /** backend 面の実行: POST /api/plugins/{id}/run。 */
  runBackend: (payload?: unknown) => Promise<unknown>;
}

/** 2D Viewer 系プラグイン（viewer2d.menu / viewer2d.toolbar）に渡すコンテキスト。 */
/** 読み出すシリーズの指定（H10 / H21）。`studyUid` 省略時は開いているタイルから解決する。 */
export interface PluginSeriesRef {
  seriesUid: string;
  studyUid?: string;
  /** 多次元シリーズのチャンネル / 時相（既定 0）。 */
  c?: number;
  t?: number;
}

/** ボリュームの格子（リサンプル先の指定にも使う）。 */
export interface PluginVolumeGrid {
  /** [nx, ny, nz] = [columns, rows, slices]。 */
  dims: [number, number, number];
  /** 各軸の実効間隔 [mm]。 */
  spacing: [number, number, number];
  /** index (i,j,k,1) → 患者 LPS mm。row-major 4×4（16 要素）。 */
  indexToWorld: number[];
  /** その逆行列。 */
  worldToIndex: number[];
}

/** H10 が返すボリューム。値は**校正済みモダリティ値**（HU / Bq/mL / SUV）。 */
export interface PluginVolume extends PluginVolumeGrid {
  /** z-major のフラット配列（長さ = nx·ny·nz）。 */
  data: Float32Array;
  /** 先頭ボクセルの ImagePositionPatient。 */
  ipp: [number, number, number];
  /** ImageOrientationPatient（6 要素）。 */
  iop: number[];
  /** スライスが 1 進むときの移動ベクトル（法線 × 間隔ではなく実測の IPP 差）。 */
  sliceStep: [number, number, number];
  frameOfReferenceUid: string | null;
  modality: string;
  /** 値の単位（`HU` / `Bq/ml` / `SUV` 等。分からなければ空文字＝**捏造しない**）。 */
  unit: string;
  /** DICOM SliceThickness（**スライス間隔とは別物**）。 */
  sliceThickness: number | null;
  seriesUid: string;
  studyUid: string;
}

/** 読み込み前の見積り（H10）。 */
export interface PluginVolumeEstimate {
  bytes: number;
  dims: [number, number, number];
  /** 患者座標（IOP/IPP）が揃っているか。false なら空間的な処理はできない。 */
  spatial: boolean;
}

/** 位置合わせの要求（H21）。 */
export interface PluginRegistrationRequest {
  fixed: PluginSeriesRef;
  moving: PluginSeriesRef;
  /** 既定 "rigid"。 */
  mode?: "rigid" | "deformable" | "rigid+deformable";
  options?: {
    metric?: string;
    pyramidMm?: number[];
    samplesPerIteration?: number;
    maxIterationsPerLevel?: number;
    seed?: number;
    limits?: { translationMm: number; rotationDeg: number };
    deformable?: {
      controlSpacingsMm?: number[];
      maxDisplacementMm?: number;
      regularizationWeight?: number;
    };
  };
}

/** 位置合わせの結果（H21）。数値は記録・表示用、`transform` はリサンプルへ渡す用。 */
export interface PluginRegistrationResult {
  /** fixed world → moving world の 4×4（row-major, 16 要素）。 */
  matrix: number[];
  center: [number, number, number];
  translationMm: [number, number, number];
  eulerDeg: [number, number, number];
  metric: string;
  metricValue: number;
  elapsedMs: number;
  aborted: boolean;
  hasDeformation: boolean;
  maxDisplacementMm: number;
  /** 本体の内部表現。**中身を見ない**で `resampleVolume` に渡す。 */
  transform: unknown;
}

export interface Viewer2DPluginHost extends PluginHostBase {
  surface: Viewer2DSurface;
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
   * 計測を **DICOM SR（構造化レポート）** として保存する（H9）。
   *
   * <p>**本体が必ず確認ダイアログを出す**（抑止不可）。ユーザーが拒否すると
   * `{ ok: false, cancelled: true }` が返る。
   *
   * <p>**DICOM はプラグインに書かせない**: 「何を測ったか」（病変ごとの追跡 ID・長径/短径・
   * 参照画像）と所見テキストを渡すだけで、SR の構造・UID 採番・患者/検査属性の引き継ぎは
   * 本体が行う。計測種別は `longAxis` / `shortAxis` のみで、**未知の種別は拒否される**
   * （黙って落とすと「入れたはずの計測が無いレポート」ができるため）。
   *
   * <p>保存された SR は `SeriesDescription` に `[Plugin] ` 接頭辞が付き、
   * `ContributingEquipmentSequence` にプラグイン id・版が入る。文書は **UNVERIFIED**
   * （アプリが読影医の確認行為を騙らない）。
   */
  saveStructuredReport: (tileId: string | undefined, req: ViewerSrRequest) => Promise<ViewerSrResult>;
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
   * **表示位置を移動する**（H14）。結果の一覧から「その ROI のスライス」へ飛ぶ用途。
   *
   * <p>範囲外は端に丸める。**読み出し（`getPixelData`）とは別**にしてあるので、
   * 読むだけで画面が動くことはない。`tileId` 省略時は対象タイル。
   */
  /**
   * **シリーズ 1 本をボリュームとして読む**（H10）。校正済みの値と**患者 LPS の幾何**が付く。
   *
   * <p>`getPixelData`（1 枚ずつ・開いているタイルのみ）では複数シリーズの格子の対応が組めない
   * （線量評価は 4〜5 時点 ×（SPECT ＋ CT）を扱う）。ここは**開いていないシリーズ**も読める。
   *
   * <p>★ **1 回 1 ボリューム。** まとめて返す API にすると呼び出し側がメモリを見積もらなくなる。
   * 大きさは {@link estimateVolume} で**先に**聞ける。`studyUid` 省略時は開いているタイルから解決。
   */
  loadVolume: (
    ref: PluginSeriesRef,
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<PluginVolume | null>;
  /** 読み込み前の大きさの見積り（H10）。 */
  estimateVolume: (ref: PluginSeriesRef) => Promise<PluginVolumeEstimate | null>;
  /**
   * **位置合わせを実行する**（H21）。剛体・非剛体・その両方。本体の検証済み実装
   * （`fw/registration-design.md`）をそのまま使う。
   *
   * <p>★ **プラグインが持っているボリュームは渡せない**（シリーズ参照だけを受ける）。
   * Worker へは画素バッファを*転送*するので、渡した側の配列は detach されて壊れるため。
   */
  registerVolumes: (
    req: PluginRegistrationRequest,
    onProgress?: (fraction: number, stage: string) => void,
  ) => Promise<PluginRegistrationResult | null>;
  /**
   * 位置合わせの結果で `source` を `target` の格子へリサンプルする（H21）。
   *
   * <p>向きは本体と同じ **target world → source world**（pull-back）。
   * **範囲外は `NaN`**（0 で埋めない ＝「視野の外」と「空気」を混同しない）。
   */
  resampleVolume: (
    source: PluginVolume,
    transform: unknown | null,
    target: PluginVolumeGrid,
  ) => PluginVolume;
  goTo: (tileId: string | undefined, dims: { sliceIndex?: number; c?: number; t?: number }) => void;
  /**
   * **ROI を選択状態にする**（H14）。`null` で解除。`exclusive` 既定 true（他の選択を外す）。
   *
   * <p>ハイライトの実体は本体の選択表示なので、プラグイン独自の強調とずれない。
   */
  selectRoi: (tileId: string | undefined, roiUid: string | null, exclusive?: boolean) => void;
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
   * **`available: false` は「読めなかった」であって「空」ではない**（保存してはいけない）。
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
  /**
   * **専用ウィンドウを開く**（H30）。本体が窓を開き、**中身の DOM だけ貸す**。
   *
   * <p>同じ文書の中に浮かぶ窓である（OS のウィンドウではない）。別文書にすると
   * `container: HTMLElement` を渡せず、Cornerstone の単一 RenderingEngine 前提も崩れる
   * （`CLAUDE.md` 絶対ルール 1・4）。詳しい理由は `plugins/pluginWindowApi.ts`。
   *
   * <p>タイトルバーには**プラグイン名が必ず出る**。消せない（`fw/subtraction-design.md` §15.8）。
   * 閉じたら本体が後始末する（貸したビューポートも一緒に落ちる）。
   */
  openWindow: (opts?: PluginWindowOptions) => PluginWindowHandle;
  /**
   * **値ボリュームを 2D ビューポートとして表示する**（H31）。W/L・パン/ズーム・スライス送りは
   * 本体の実装がそのまま効く。
   *
   * <p>幾何とメタデータは `referenceTileId` が表示しているシリーズへ委譲するので、
   * 参照線・向きマーカー・座標同期が元シリーズと一致する。
   *
   * <p>🔴 **ボリュームの k と参照シリーズのスライスは 1:1 で対応していること。**
   * 並びが違うと「ずれた絵」ではなく**「もっともらしいが別スライスの絵」**になり、見て気付けない。
   * 対応は呼び出し側が確かめること（`getPixelData` で数枚読み比べれば足りる）。
   *
   * <p>値は**校正済みのまま**扱われる（Modality LUT は恒等）。`pixelCalibration` を通った値を
   * 渡すこと。二重適用すると CT で約 −1024 ずれる。
   */
  mountViewport: (
    el: HTMLElement,
    volume: PluginValueVolume,
    referenceTileId: string | undefined,
    opts?: PluginViewportOptions,
  ) => Promise<PluginViewportHandle | null>;
  /**
   * **値ボリュームを 3D（MIP / MINIP / VR）で表示する**（H32）。
   *
   * <p>🔴 `NaN` は投影の前に潰される（MIP なら最小値、MINIP なら最大値で埋める）。
   * 「データが無い」ところが投影で勝たないようにするため。埋める値は `background` で変えられる。
   */
  mountVolumeView: (
    el: HTMLElement,
    volume: PluginValueVolume,
    opts?: { mode?: PluginVolumeViewMode; background?: number; preset?: string },
  ) => Promise<PluginVolumeViewHandle | null>;
  /**
   * **マスクをメッシュ化して測る**（H33）。0=背景 / >0=セグメント番号。
   *
   * <p>セグメントごとに別のメッシュとして測る。**幾何と計測はプラグインに書かせない**
   * ——同じ量を 2 か所で計算すると、食い違ったときにどちらが正しいか言えなくなる（H5 と同じ理由）。
   *
   * <p>🔴 返る体積は 2 種類ある。`voxelVolumeMm3`（数え上げ）と `meshVolumeMm3`
   * （平滑化した曲面）は**一致しない**。どちらが正しいでもないので両方返す。
   */
  measureMask: (mask: PluginMaskInput, opts?: PluginMeshOptions) => PluginMeshMeasurement[];
  /**
   * **シリーズビューパネルをそのまま貸す**（H34）。W/L バー・スライダ・ThickSlab・参照線・
   * 計測・シネ、そして**フュージョン重畳**が丸ごと付いてくる。
   *
   * <p>H31（ビューポートを素で貸す）との使い分け:
   * **保管庫にある実シリーズはこちら**、プラグインが計算した値ボリュームは H31。
   * `SeriesViewer` は `instances` を受け取る作りなので、値ボリュームはここには載らない。
   *
   * <p>`fusion.transform` には `registerVolumes`（H21）が返した `transform` をそのまま渡す
   * （**中身を見ない**）。位置合わせの結果がそのまま重畳に反映される。
   *
   * <p>⚠️ 渡した要素の中身は**本体が管理する**（React ルートを張る）。プラグイン側から
   * 子要素を触らないこと。`destroy()` で返す。
   */
  mountSeriesPanel: (
    el: HTMLElement,
    series: PluginSeriesRef,
    opts?: PluginSeriesPanelOptions,
  ) => Promise<PluginSeriesPanelHandle | null>;
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
