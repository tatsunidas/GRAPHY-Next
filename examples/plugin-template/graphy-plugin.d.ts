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
  /**
   * 同一患者の判定キー（PatientID → PatientName → StudyInstanceUID）。
   * 本体が ROI を永続化する鍵と同じ値。**患者単位の記録を持つならこれを鍵にする**
   * （スタディ UID を鍵にすると、同じ患者の別スタディを開いたときに記録を見失う）。**0.1.11 以降**。
   */
  patientKey: string;
  studyUid: string;
  /**
   * スタディの検査日（ISO `YYYY-MM-DD`）。DICOM の StudyDate 由来。
   * 解釈できない・存在しないなら `null`（怪しい日付は通さない）。**0.1.10 以降**。
   */
  studyDate: string | null;
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

/** `getPixelData` の任意指定。**0.1.9 以降**。 */
export interface PixelDataOptions {
  /**
   * 読み出すスライス（Z）の 0 始まり index。既定は表示中スライス。
   * 範囲外は拒否（null が返る）＝黙って別のスライスにはならない。
   */
  sliceIndex?: number;
}

/**
 * スライス 1 枚の**校正済み画素**。`host.getPixelData()` の戻り。**0.1.9 以降**。
 *
 * <p>値はモダリティ値（CT なら HU、SUV 校正済み PET なら SUV）で、**表示 W/L は掛かっていない**
 * ＝定量処理に使える。カラー（RGB）画像は輝度に落ちて `unit === "raw"`。
 */
export interface PixelData {
  tileId: string;
  imageId: string;
  /** 実際に読み出したスライスの index。 */
  sliceIndex: number;
  /** 行数・列数。`data.length === rows * cols`。 */
  rows: number;
  cols: number;
  /** row-major。`data[y * cols + x]`。 */
  data: Float32Array;
  /** 値の単位（"HU" / "SUVbw" / "" / カラーは "raw"）。 */
  unit: string;
  /**
   * 画素間隔 [列方向(x), 行方向(y), スライス方向(z)] mm。不明な軸は null。
   * z は**スライス間隔**で、ギャップのある収集ではスライス厚と一致しない。
   */
  spacing: [number | null, number | null, number | null];
  /**
   * DICOM SliceThickness (0018,0050) mm。無ければ null（間隔で代用しない）。**0.1.12 以降**。
   */
  sliceThickness: number | null;
}

/** `showOverlay` に渡す値マップ。**0.1.9 以降**。 */
export interface Overlay {
  /** rows*cols, row-major。`NaN` は透明。 */
  data: Float32Array;
  /** 現在スライスの rows/cols と一致していること（不一致は拒否）。 */
  rows: number;
  cols: number;
  /** 値 → 濃淡の窓。省略時は data の min/max（NaN 以外）で自動。 */
  window?: { center: number; width: number };
  /** 本体の LUT 名（例 "Hot_Iron"）。省略/null はグレースケール。 */
  colormap?: string | null;
  /** 不透明度 0〜1（既定 0.5）。 */
  opacity?: number;
}

/** `saveDerivedSeries` に渡す保存要求。**0.1.9 以降**。 */
export interface DerivedSeriesRequest {
  /** 新シリーズの説明。保存時に本体が `[Plugin] ` 接頭辞を付ける。 */
  seriesDescription: string;
  /**
   * フレーム（1 枚以上）。`sliceIndex` は**元シリーズのどのスライスに対応するか**。
   * 幾何（IPP/IOP/PixelSpacing/厚み）は本体が元シリーズから引き継ぐので、プラグインは書かない。
   */
  frames: Array<{ sliceIndex: number; data: Float32Array }>;
  /** 元スライスと一致していること（不一致は拒否）。 */
  rows: number;
  cols: number;
  /** 値の単位（`RescaleType` に入る。例 "HU"）。 */
  unit?: string;
  /** 派生内容の説明。プラグイン id・版は本体が併記する。 */
  derivationDescription?: string;
  /**
   * `NaN`（データ無し）の画素を埋める値。**`data` に `NaN` を含むなら必須**（未指定は拒否）。
   *
   * <p>本体が勝手に決めない: 閾値マスクのように「有効値がすべて閾値以上」の場合、最小値で埋めると
   * **背景が閾値そのものの値**になり、何も無い場所が組織と同程度の値を持つ誤ったシリーズになる。
   * CT のマスクなら空気の `-1000` が素直。指定した値は DICOM の `PixelPaddingValue` にも書かれる。
   */
  background?: number;
}

/** 保存結果。`cancelled` はユーザーが確認ダイアログで拒否した場合。**0.1.9 以降**。 */
export interface DerivedSeriesResult {
  ok: boolean;
  cancelled?: boolean;
  seriesInstanceUid?: string;
  instanceCount?: number;
  error?: string;
}

/**
 * ROI 1 件の計測値。**取れない項目は `undefined`**（「測っていない」と「0 だった」を区別する）。
 *
 * <p>長径・短径が **2 系統ある**のは意図的で、黙って片方を代入しないため。
 * `Bidirectional`（ROI メニューの「長径・短径（RECIST）」）はユーザーが 2 軸を明示的に引くので
 * `length` / `shortAxis` を使い、楕円・矩形・自由曲線は `longAxisMm` / `shortAxisMm`
 * （形状から本体が算出）を使う。**0.1.9 以降**。
 */
export interface ViewerRoiMeasurements {
  /** ツール自身の主計測 (mm)。Length の長さ、Bidirectional の長軸。 */
  length?: number;
  /** Bidirectional の短軸 (mm)。ユーザーが長軸に直交して引いた軸。 */
  shortAxis?: number;
  /** 形状の頂点から本体が算出した最遠 2 点間距離 (mm)＝RECIST の「長径」。 */
  longAxisMm?: number;
  /** 上記の長径に**直交**する方向の広がり (mm)＝RECIST の「短径」。全方位の最小幅ではない。 */
  shortAxisMm?: number;
  /** 長径の両端（画素座標）。 */
  longAxisEnds?: [[number, number], [number, number]];
  /** 面 ROI の面積 (mm²)。 */
  area?: number;
  /** ROI 内のモダリティ値統計（CT なら HU。表示 W/L は掛かっていない）。 */
  mean?: number;
  stdDev?: number;
  min?: number;
  max?: number;
  /** 統計値の単位（"HU" / "SUVbw" / ""）。 */
  unit?: string;
}

/**
 * ユーザーが描いた ROI（計測・幾何注釈）1 件。`host.getRois()` の要素。**0.1.9 以降**。
 *
 * <p>⚠ **`roiUid` はセッション内でのみ安定**（本体に ROI の永続化が無い）。時系列で同じ病変を
 * 追うなら `sopInstanceUid` ＋ `points` ＋自分で振った ID で記録し、`roiUid` を鍵にしないこと。
 */
export interface ViewerRoi {
  roiUid: string;
  /** ツール種別（"Length" / "Bidirectional" / "EllipticalROI" / "PlanarFreehandROI" 等）。 */
  tool: string;
  /** ROI マネージャで付けたラベル。未設定なら null。 */
  label: string | null;
  /** どのタイルで読んだ ROI か。 */
  tileId: string;
  /** 同一患者の判定キー（本体が ROI を永続化する鍵と同じ値）。**0.1.11 以降**。 */
  patientKey: string;
  studyUid: string;
  /** この ROI が属するスタディの検査日（ISO `YYYY-MM-DD`）。不明なら null。**0.1.10 以降**。 */
  studyDate: string | null;
  seriesUid: string;
  /** 解決できなければ null。 */
  sopInstanceUid: string | null;
  /** 表示スタック内の 0 始まり index。 */
  sliceIndex: number;
  /**
   * ROI の Z スコープ。**`"all"`（全スライス共通の global ROI）だと `sliceIndex` /
   * `sopInstanceUid` は「いま見ているスライス」を指すだけで病変の位置ではない**。
   * 計測を時系列で記録する用途では弾くこと。
   */
  zScope: number | "all" | null;
  c: number;
  t: number;
  /** 頂点（画像画素座標。x=列, y=行, 0 始まり・サブピクセル可）。 */
  points: Array<[number, number]>;
  /** 面内画素間隔 [列方向(x), 行方向(y)] mm。不明な軸は null。 */
  spacing: [number | null, number | null];
  measurements: ViewerRoiMeasurements;
  visible: boolean;
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
  /**
   * 対象タイルのスライス 1 枚の**校正済み画素**（HU / SUV。表示 8bit ではない）。
   * `tileId` 省略時は対象の先頭タイル。取得不能・`sliceIndex` が範囲外なら null。**0.1.9 以降**。
   *
   * <p>1 回 1 スライス。シリーズ全体が要るなら `sliceIndex` を変えて回すこと
   * （512×512×500 を Float32 で全部持つと 500MB を超える）。
   *
   * <p>患者の生画素を扱う API なので、使うプラグインは `plugin.json` の `permissions` に
   * `"read-pixels"` を宣言すること（導入時の同意画面に出る）。
   */
  getPixelData: (tileId?: string, opts?: PixelDataOptions) => Promise<PixelData | null>;
  /**
   * 処理結果（値マップ）を**表示中スライスへ重ねて見せる**。`tileId` 省略時は対象の先頭タイル。
   * rows/cols が現在スライスと不一致なら false。**0.1.9 以降**。
   *
   * <p>渡すのは値だけ。色付け（`window` / `colormap` / `opacity`）は本体がする。
   * `NaN` の画素は透明になるので、マスクや部分的なマップをそのまま渡せる。
   * 本体が画像左下に「プラグイン: <名前>」のラベルを出す。
   *
   * <p>オーバーレイは**出したスライスに紐付く**（他スライスでは隠れ、戻ると再表示。
   * シリーズ切替では破棄）。**保存はされない**（派生シリーズ保存は未実装）。
   */
  showOverlay: (tileId: string | undefined, overlay: Overlay) => boolean;
  /** オーバーレイを消す。`tileId` 省略時は対象タイル全部。**0.1.9 以降**。 */
  clearOverlay: (tileId?: string) => void;
  /**
   * 処理結果を**派生シリーズとして保存する**（standalone はこの PC の保管庫、web は接続中の PACS）。
   * **0.1.9 以降**。
   *
   * <p>**本体が必ず確認ダイアログを出す**（抑止不可）。ユーザーが拒否すると
   * `{ ok: false, cancelled: true }` が返る。プラグインが黙って保存することはできない。
   *
   * <p>画素は 16bit signed ＋ Rescale で保存される（HU のような整数はそのまま、確率マップのような
   * 小さい実数は値域から係数を決めて量子化）。**`NaN` を含むなら `background` が必須**。
   * 保存物には `[Plugin] ` 接頭辞とプラグイン id・版が必ず残る。**元シリーズは変更されない。**
   */
  saveDerivedSeries: (tileId: string | undefined, req: DerivedSeriesRequest) => Promise<DerivedSeriesResult>;
  /**
   * ユーザーが描いた **ROI（計測・幾何注釈）を読む**。`tileId` 省略時は**対象タイル全部**
   * （他の問い合わせ系は「先頭タイル」だがこれだけ違う。ベースラインと追跡を並べて開く用途を想定）。
   * ROI が無ければ空配列。**0.1.9 以降**。
   *
   * <p>**呼ぶたびに現在値を読む**。ユーザーは ROI を編集し続けるので、活性化時の
   * スナップショットを持ち回らないこと。
   */
  getRois: (tileId?: string) => ViewerRoi[];
  /**
   * ROI に紐付けた**このプラグインの属性**を読む。未設定なら空オブジェクト。
   * キーは自動で `plugin.<pluginId>.` 名前空間に置かれるので、他プラグインの属性とは混ざらない。
   */
  getRoiMeta: (roiUid: string) => Record<string, string>;
  /**
   * ROI に**このプラグインの属性**を書く（既存キーはマージ更新）。ROI が無ければ false。
   * 例: 病変の追跡 ID・標的/非標的の区分・測定ステータス。
   *
   * <p>属性は ROI と同じ寿命しか持たない（本体に ROI の永続化が無いため、アプリ再起動で消える）。
   * 永続化が要るならプラグイン側で保存すること。
   */
  setRoiMeta: (roiUid: string, patch: Record<string, string>) => boolean;
  /**
   * ROI の追加・変更・削除を購読する。返り値を呼ぶと解除（ダイアログを閉じるときは必ず解除する）。
   * **何が変わったかは渡さない**ので、通知を受けたら `getRois()` を読み直すこと。
   */
  subscribeRois: (listener: () => void) => () => void;
  /**
   * **このプラグイン専用の保存領域**を読む（患者単位・backend 保管）。**0.1.12 以降**。
   * 未保存でもエラーにならず `json: null` が返る。`patientKey` 省略時は対象タイルの患者。
   */
  loadStore: (patientKey?: string) => Promise<PluginStoreDoc>;
  /**
   * **このプラグイン専用の保存領域**へ書く。**0.1.12 以降**。
   *
   * <p>`version` は `loadStore()` で受け取った値をそのまま返送する規約。別ウィンドウ・別端末が
   * 先に保存していたら `{ ok: false, conflict: true }` が返るので、**読み直して統合してから**
   * 新しい版で再保存すること（単純な上書きは相手の記録を消す）。初回保存は `version: null`。
   */
  saveStore: (
    json: string,
    opts?: { patientKey?: string; version?: number | null },
  ) => Promise<PluginStoreSaveResult>;
  /** **このプラグイン専用の保存領域**を消す。**0.1.12 以降**。 */
  deleteStore: (patientKey?: string) => Promise<boolean>;
  /**
   * 計測を **DICOM SR（構造化レポート）** として保存する。**0.1.12 以降**。
   *
   * <p>**本体が必ず確認ダイアログを出す**（抑止不可）。拒否されると `{ ok:false, cancelled:true }`。
   * DICOM の構造・UID 採番・患者/検査属性の引き継ぎは本体が行うので、プラグインは
   * 「何を測ったか」だけを渡す。計測種別は `longAxis` / `shortAxis` のみ
   * （**未知の種別は拒否される**。黙って落とすと「入れたはずの計測が無いレポート」になるため）。
   */
  saveStructuredReport: (tileId: string | undefined, req: SrRequest) => Promise<SrResult>;
}

/** 計測レポートの保存要求。**0.1.12 以降**。 */
export interface SrRequest {
  /** シリーズ説明（一覧に出る。`[Plugin] ` が前置される）。 */
  seriesDescription?: string;
  /** 文書タイトル（自由文）。 */
  documentTitle?: string;
  /** 観測者名（読影医）。 */
  observerName?: string;
  /** 計測グループ（病変ごと）。 */
  groups: SrMeasurementGroup[];
  /** 所見テキスト（経時判定のまとめ等）。 */
  findings?: { label: string; text: string }[];
}

export interface SrMeasurementGroup {
  /** 病変の追跡 ID（時系列で同じ病変を結ぶ鍵。**必須**）。 */
  trackingId: string;
  /** 追跡 UID。省略時は本体が採番する。 */
  trackingUid?: string;
  /** 所見の説明（"Target lesion" 等）。 */
  findingText?: string;
  /** 計測した画像。省略時は表示中シリーズが使われる（SOP を省略すると画像参照なし）。 */
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  measurements: { type: "longAxis" | "shortAxis"; value: number; unit?: string }[];
}

export interface SrResult {
  ok: boolean;
  /** ユーザーが確認ダイアログで拒否した。 */
  cancelled?: boolean;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  error?: string;
}

/** プラグイン保存領域の読み出し結果。**0.1.12 以降**。 */
export interface PluginStoreDoc {
  /**
   * **読み出せたか**。`false` は「読めなかった」であって「空」ではない。
   * 混ぜると、到達できないときに「記録が無い」と判断して保存し、**サーバ側の記録を空で上書き**する。
   * `false` のときは保存しないこと。
   */
  available: boolean;
  /** 保存されている JSON。未保存なら null。 */
  json: string | null;
  /** 楽観ロックの版。保存時にそのまま返送する。未保存なら null。 */
  version: number | null;
  /** 最終更新（ISO）。未保存なら null。 */
  updatedAt: string | null;
}

/** プラグイン保存領域への保存結果。**衝突（conflict）を握り潰さないこと**。**0.1.12 以降**。 */
export type PluginStoreSaveResult =
  | { ok: true; version: number }
  | { ok: false; conflict: true; message: string }
  | { ok: false; conflict: false; message: string };

/** MainScreen 系（mainscreen.menu）に渡るコンテキスト。 */
export interface MainScreenPluginHost extends PluginHostBase {
  surface: "mainscreen.menu";
  /** 選択中スタディの UID（未選択なら null）。 */
  selectedStudyUid: string | null;
}

export type PluginHost = Viewer2DPluginHost | MainScreenPluginHost;
