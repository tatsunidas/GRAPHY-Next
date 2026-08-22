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

/**
 * プラグインを組み込む先（UI サーフェス）。
 *
 * <p>`viewer2d.menu.analysis` は **2D ビューアの「解析」メニュー**に出す（**0.2.1 以降**）。
 * `viewer2d.menu`（＝「プラグイン」メニュー）とは**出る場所だけ**が違い、host の中身は同一。
 * 本体の解析機能と並ぶ位置なので、**本体が区切り線と「（プラグイン）」の印を付ける**
 * — プラグイン側で名前に「プラグイン」と入れる必要はない（二重に出る）。
 */
export type PluginSurface =
  | "viewer2d.menu"
  | "viewer2d.menu.analysis"
  | "viewer2d.toolbar"
  | "mainscreen.menu";

/** 2D Viewer 系サーフェス（host の形が同じもの）。 */
export type Viewer2DSurface = "viewer2d.menu" | "viewer2d.menu.analysis" | "viewer2d.toolbar";

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

/**
 * 読み出すシリーズの指定（`loadVolume` / `registerVolumes`）。**0.2.0 以降**。
 * `studyUid` 省略時は開いているタイルから解決する（**患者を跨いでは読めない**）。
 */
export interface PluginSeriesRef {
  seriesUid: string;
  studyUid?: string;
  /** 多次元シリーズのチャンネル / 時相（既定 0）。 */
  c?: number;
  t?: number;
}

/** ボリュームの格子（リサンプル先の指定にも使う）。**0.2.0 以降**。 */
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

/**
 * `loadVolume` が返すボリューム。値は**校正済みモダリティ値**（HU / Bq/mL / SUV）。
 * **0.2.0 以降**。
 */
export interface PluginVolume extends PluginVolumeGrid {
  /** z-major のフラット配列（長さ = nx·ny·nz）。`data[i + j*nx + k*nx*ny]`。 */
  data: Float32Array;
  /** 先頭ボクセルの ImagePositionPatient。 */
  ipp: [number, number, number];
  /** ImageOrientationPatient（6 要素）。 */
  iop: number[];
  /** スライスが 1 進むときの移動ベクトル（法線 × 間隔ではなく**実測の IPP 差**）。 */
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

/** 読み込み前の見積り。**0.2.0 以降**。 */
export interface PluginVolumeEstimate {
  bytes: number;
  dims: [number, number, number];
  /** 患者座標（IOP/IPP）が揃っているか。**false なら空間的な処理はできない**。 */
  spatial: boolean;
}

/** 位置合わせの要求。**0.2.0 以降**。 */
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

/**
 * 位置合わせの結果。数値は記録・表示用、`transform` はリサンプルへ渡す用。**0.2.0 以降**。
 */
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

// ── H30〜H33: 「見せる」側の貸し出し（**0.2.1 以降**） ───────────────────────

/** プラグイン専用ウィンドウのハンドル（H30）。 */
export interface PluginWindowHandle {
  /** プラグインが自由に使ってよい DOM。ここより外は触らない。 */
  container: HTMLElement;
  close(): void;
  /** 閉じられたときに呼ばれる（ユーザーが × を押した場合も含む）。 */
  onClose(listener: () => void): void;
  readonly closed: boolean;
}

export interface PluginWindowOptions {
  title?: string;
  width?: number;
  height?: number;
}

/** プラグインが作った値ボリューム（`PluginVolume` の部分集合）。 */
export interface PluginValueVolume {
  /** z-major のフラット配列（長さ nx·ny·nz）。`NaN` は「データ無し」。 */
  data: Float32Array;
  dims: [number, number, number];
  /** index (i,j,k,1) → 患者 LPS mm。row-major 4×4。 */
  indexToWorld: number[];
  unit?: string;
}

/**
 * フュージョンの前景（**0.2.1 以降**）。**下地とは別のビューポート**として重ねる。
 *
 * 🔴 単一チャンネルのビューポートでは「灰色の下地 ＋ 色の前景 ＋ 透過度」は表現できない。
 * host は同じ要素にもう 1 枚ビューポートを重ね、カメラとスライスを同期し、
 * `mix-blend-mode: screen` ＋ `opacity` で合成する（cornerstone の背景の黒が不透明なので、
 * 素の透過だけで重ねると下地が濁る）。
 */
export interface PluginViewportOverlay {
  data: Float32Array;
  /** 前景の LUT 名。省略/null はグレースケール。 */
  colormap?: string | null;
  /** 0〜1（既定 0.5）。 */
  opacity?: number;
  window?: { center: number; width: number };
}

export interface PluginViewportOptions {
  /** 表示窓。省略時は値域の 1〜99% から決める。 */
  window?: { center: number; width: number };
  /** フュージョンの前景。省略すると 1 層のまま。**0.2.1 以降**。 */
  overlay?: PluginViewportOverlay;
  /**
   * カラーマップ名。省略/null はグレースケール。
   *
   * - `"divergent"` … **host が必ず用意する発散色**（負=青 / 0=暗灰 / 正=赤）。差分向け。
   * - 本体の LUT 名（例 `"Hot_Iron"`）… ⚠️ **ユーザーが LUT ダイアログで 1 度使うまで
   *   登録されない**ので、当てにすると灰色のままになることがある。
   * - cornerstone の colormap 名もそのまま通る。
   *
   * 解決できない名前は**グレースケールで出し、コンソールに理由を残す**（黙って無視しない）。
   */
  colormap?: string | null;
  sliceIndex?: number;
}

export interface PluginViewportHandle {
  setSlice(index: number): void;
  getSlice(): number;
  setWindowLevel(center: number, width: number): void;
  /**
   * **中身だけ差し替える**（大きさは同じであること）。**0.2.1 以降**。
   *
   * <p>`destroy()` → `mountViewport()` ではカメラ（ズーム・パン）とスライス位置が毎回飛ぶ。
   * 手で動かしながら見るような用途ではこちらを使う。
   */
  setVolume(volume: PluginValueVolume, opts?: PluginViewportOptions): Promise<void>;
  /** 前景だけ差し替える（`overlay` を渡していたときのみ効く）。**0.2.1 以降**。 */
  setOverlay(overlay: PluginViewportOverlay): Promise<void>;
  /** 前景の透過度だけ変える（再サンプル不要・その場で効く）。**0.2.1 以降**。 */
  setOverlayOpacity(opacity: number): void;
  destroy(): void;
}

export type PluginVolumeViewMode = "MIP" | "MINIP" | "VR";

export interface PluginVolumeViewHandle {
  setMode(mode: PluginVolumeViewMode): Promise<void>;
  destroy(): void;
}

/** シリーズビューパネルの貸し出し（H34・**0.2.1 以降**）。 */
export interface PluginSeriesPanelOptions {
  /** 重ねるシリーズ（省略でフュージョンなし）。 */
  fusion?: {
    series: PluginSeriesRef;
    /** `registerVolumes`（H21）が返した `transform` をそのまま渡す（**中身を見ない**）。 */
    transform?: unknown;
    /** 重ねる側の不透明度（0〜1・既定 0.5）。 */
    opacity?: number;
    /**
     * 重ねる側の **LUT 名**（既定 `"Hot_Iron"`）。`null` でグレースケール。
     * 名前は host が実データへ解決する（**プラグインが LUT を取りに行く必要はない**）。
     * 読めない名前を渡したときはグレースケールで描き、コンソールに理由を残す。
     */
    lut?: string | null;
  };
  /** 画像下の操作パネルを出すか（既定 true）。 */
  showControls?: boolean;
}

export interface PluginSeriesPanelHandle {
  destroy(): void;
}

/** メッシュ化して測るマスク（H33）。0=背景, >0=セグメント番号。 */
export interface PluginMaskInput {
  data: Uint8Array;
  dims: [number, number, number];
  indexToWorld: number[];
}

export interface PluginMeshOptions {
  /** 測るセグメント番号。省略時はマスクに出てくる番号すべて。 */
  segments?: number[];
  /** 平滑化反復数（0 で無効）。既定 15。 */
  smoothIterations?: number;
  passBand?: number;
}

export interface PluginMeshMeasurement {
  segment: number;
  voxelCount: number;
  /** ボクセル数 × 1 ボクセルの体積。 */
  voxelVolumeMm3: number;
  voxelVolumeMl: number;
  /** メッシュ（平滑化後の曲面）の体積。**ボクセル数の体積とは一致しない**。 */
  meshVolumeMm3: number;
  meshVolumeMl: number;
  surfaceAreaMm2: number;
  /** 主径 [長径, 中径, 短径]（mm・PCA 軸への投影範囲）。 */
  diameters: [number, number, number];
  numTriangles: number;
  numPoints: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
}

interface PluginHostBase {
  /** 自分の plugin.json の id。 */
  pluginId: string;
  /** i18n 取得関数（ホスト言語に追従）。 */
  t: (key: string) => string;
  /**
   * いまの表示言語（`"ja"` / `"en"`）。**プラグインが自前の文言を持つ場合の言語判定に使う**
   * （`t()` は本体のキーしか引けない）。**0.1.12 以降**。
   *
   * <p>値は活性化した時点のもの。プラグインの UI は本体の React ツリーの外にあるため、
   * 途中で言語を切り替えても自動では追従しない（切り替えたら開き直す）。
   */
  locale: string;
  /** ユーザーへの簡易通知。 */
  notify: (message: string) => void;
  /** バックエンド面（Java 実装）を呼ぶ: POST /api/plugins/{id}/run。standalone のみ実行可。 */
  runBackend: (payload?: unknown) => Promise<unknown>;
}

/** 2D Viewer 系サーフェスに渡るコンテキスト。 */
export interface Viewer2DPluginHost extends PluginHostBase {
  surface: Viewer2DSurface;
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
   * **シリーズ 1 本をボリュームとして読む**。校正済みの値と**患者 LPS の幾何**が付く。
   * **0.2.0 以降**。
   *
   * <p>`getPixelData`（1 枚ずつ・開いているタイルのみ）では複数シリーズの格子の対応が組めない。
   * こちらは**開いていないシリーズ**も読める（同じ患者の中で）。
   *
   * <p>★ **1 回 1 ボリューム。** 大きさは {@link Viewer2DPluginHost.estimateVolume} で
   * **先に**聞ける。数百 MB になり得るので、聞かずに複数本読まないこと。
   *
   * <p>NM（SPECT）の多フレーム断層も、本体が Z に展開してから読む。ただし
   * **間隔が無いシリーズでは座標を作らない**（捏造しない）ので `spatial: false` になる。
   */
  loadVolume: (
    ref: PluginSeriesRef,
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<PluginVolume | null>;
  /** 読み込み前の大きさの見積り。**0.2.0 以降**。 */
  estimateVolume: (ref: PluginSeriesRef) => Promise<PluginVolumeEstimate | null>;
  /**
   * **位置合わせを実行する**（剛体・非剛体・その両方）。本体の検証済み実装をそのまま使う。
   * **0.2.0 以降**。
   *
   * <p>★ **プラグインが持っているボリュームは渡せない**（シリーズ参照だけを受ける）。
   * Worker へは画素バッファを*転送*するので、渡した側の配列が detach されて壊れるため。
   */
  registerVolumes: (
    req: PluginRegistrationRequest,
    onProgress?: (fraction: number, stage: string) => void,
  ) => Promise<PluginRegistrationResult | null>;
  /**
   * 位置合わせの結果で `source` を `target` の格子へリサンプルする。**0.2.0 以降**。
   *
   * <p>向きは **target world → source world**（pull-back）。
   * **範囲外は `NaN`**（0 で埋めない ＝「視野の外」と「空気」を混同しない）。
   * `transform` に `null` を渡すと、幾何だけで格子を合わせる（位置合わせなしのリサンプル）。
   */
  resampleVolume: (
    source: PluginVolume,
    transform: unknown | null,
    target: PluginVolumeGrid,
  ) => PluginVolume;
  /**
   * **表示位置を移動する**。結果の一覧から「その ROI のスライス」へ飛ぶ用途。**0.1.13 以降**。
   *
   * <p>範囲外は端に丸める。**読み出し（`getPixelData`）とは別**にしてあるので、
   * 読むだけで画面が動くことはない。`tileId` 省略時は対象タイル。
   */
  goTo: (tileId: string | undefined, dims: { sliceIndex?: number; c?: number; t?: number }) => void;
  /**
   * **ROI を選択状態にする**。`null` で解除。`exclusive` 既定 true（他の選択を外す）。
   * **0.1.13 以降**。
   *
   * <p>ハイライトの実体は本体の選択表示なので、プラグイン独自の強調とずれない。
   */
  selectRoi: (tileId: string | undefined, roiUid: string | null, exclusive?: boolean) => void;
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
   * **専用ウィンドウを開く**（H30・**0.2.1 以降**）。本体が窓を開き、**中身の DOM だけ貸す**。
   *
   * <p>同じ文書の中に浮かぶ窓である（OS のウィンドウではない）。別文書にすると
   * `container: HTMLElement` を渡せず、Cornerstone の単一 RenderingEngine 前提も崩れるため。
   *
   * <p>タイトルバーには**プラグイン名が必ず出る**（消せない）。閉じたら本体が後始末し、
   * その窓に貸したビューポートも一緒に落ちる。
   */
  openWindow: (opts?: PluginWindowOptions) => PluginWindowHandle;
  /**
   * **値ボリュームを 2D ビューポートとして表示する**（H31・**0.2.1 以降**）。
   * W/L・パン/ズーム・スライス送りは本体の実装がそのまま効く。
   *
   * <p>幾何とメタデータは `referenceTileId` が表示しているシリーズへ委譲するので、
   * 参照線・向きマーカー・座標同期が元シリーズと一致する。
   *
   * <p>🔴 **ボリュームの k と参照シリーズのスライスは 1:1 で対応していること。**
   * 並びが違うと「ずれた絵」ではなく**「もっともらしいが別スライスの絵」**になり、見て気付けない。
   * `getPixelData()` で数枚読み比べてから渡すこと。
   *
   * <p>値は**校正済みのまま**扱われる（Modality LUT は恒等）。生の格納値を渡さないこと。
   */
  mountViewport: (
    el: HTMLElement,
    volume: PluginValueVolume,
    referenceTileId: string | undefined,
    opts?: PluginViewportOptions,
  ) => Promise<PluginViewportHandle | null>;
  /**
   * **値ボリュームを 3D（MIP / MINIP / VR）で表示する**（H32・**0.2.1 以降**）。
   *
   * <p>🔴 `NaN` は投影の前に潰される（MIP なら最小値、MINIP なら最大値で埋める）。
   * 「データが無い」ところが投影で勝たないようにするため。`background` で変えられる。
   */
  mountVolumeView: (
    el: HTMLElement,
    volume: PluginValueVolume,
    opts?: { mode?: PluginVolumeViewMode; background?: number; preset?: string },
  ) => Promise<PluginVolumeViewHandle | null>;
  /**
   * **マスクをメッシュ化して測る**（H33・**0.2.1 以降**）。セグメントごとに別のメッシュにする。
   *
   * <p>🔴 返る体積は 2 種類ある。`voxelVolumeMm3`（数え上げ）と `meshVolumeMm3`
   * （平滑化した曲面）は**一致しない**。どちらが正しいでもないので両方返す。
   */
  measureMask: (mask: PluginMaskInput, opts?: PluginMeshOptions) => PluginMeshMeasurement[];
  /**
   * **シリーズビューパネルをそのまま貸す**（H34・**0.2.1 以降**）。W/L バー・スライダ・
   * ThickSlab・参照線・計測・シネ、そして**フュージョン重畳**が丸ごと付いてくる。
   *
   * <p>使い分け: **保管庫にある実シリーズはこちら**、プラグインが計算した値ボリュームは
   * `mountViewport`（H31）。`SeriesViewer` は `instances` を受け取る作りなので、
   * 値ボリュームはここには載らない。
   *
   * <p>⚠️ 渡した要素の中身は**本体が管理する**（React ルートを張る）。
   * プラグイン側から子要素を触らないこと。`destroy()` で返す。
   */
  mountSeriesPanel: (
    el: HTMLElement,
    series: PluginSeriesRef,
    opts?: PluginSeriesPanelOptions,
  ) => Promise<PluginSeriesPanelHandle | null>;
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

/**
 * `ui.js`（ES モジュール）が公開する契約。
 * `export function activate(host) {}` か、default export で `{ activate }`。
 *
 * <p>⚠️ **`ui.js` は単一ファイルとして配信される**（`GET /api/plugins/{id}/ui.js`）。
 * バンドラを通らないので、**bare specifier も相対 import も使えない**
 * （`./core/foo.js` は 404 になる）。ソースを分割するなら、配布前に 1 ファイルへ束ねること。
 */
export interface PluginModule {
  activate(host: PluginHost): void | Promise<void>;
}
