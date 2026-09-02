/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D Viewer のコマンドレジストリ（グローバル）。
 *
 * 各 base `Viewer2D`（SliderView）が `tileId` をキーに命令ハンドラを登録し、
 * 画面の `Viewer2DToolbar` / `Viewer2DMenuBar` が対象タイル群（選択 or 全）へコマンドを送出する。
 * Viewer2D 内部の命令的操作（Fit/回転/Invert/LUT…）を外から起動するための薄い仲介。
 * referenceLines/sliceSync と同じモジュールレベル・レジストリ方式。
 */
import type { PluginAnalysisInput } from "../report/analysisResults";
import type {
  AngioPresentationRequest,
  LutData,
  Qca3dSrRequest,
  QcaSrRequest,
  QlvSrRequest,
} from "../api";

/**
 * タイル 1 枚が「いま何を表示しているか」（プラグイン host API の H1・fw/plugin-architecture.md §7）。
 *
 * <p>`tileId` は付与しない: レジストリのキー＝tileId なので、問い合わせた側が知っている。
 */
export interface ViewerTargetInfo {
  /**
   * 同一患者の判定キー（PatientID → 無ければ PatientName → 無ければ StudyInstanceUID）。
   * 本体が ROI を永続化するときの鍵と**同じ値**。
   *
   * <p>時系列のプラグインが「患者単位の記録」を持つのに要る。スタディ UID を鍵にすると、
   * 同じ患者の別スタディを開いたときに記録を見失う。
   */
  patientKey: string;
  studyUid: string;
  /**
   * スタディの検査日（ISO `YYYY-MM-DD`）。DICOM の StudyDate から解決する。
   * 解釈できない・存在しないなら `null`（**怪しい日付を通さない**）。
   *
   * <p>時系列の評価（RECIST の BOR は「ベースラインから何週」「確認まで何日」で結論が変わる）に要る。
   */
  studyDate: string | null;
  seriesUid: string;
  /** 画面に出ているシリーズ名（"3: AXIAL CT" 等）。 */
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
 * タイル 1 枚の表示状態（プラグイン host API の H2）。
 *
 * <p>W/L は**モダリティ値空間**（CT なら HU、SUV 校正済み PET なら Bq/mL）。表示単位は `unit`。
 */
export interface ViewerViewState {
  windowCenter: number;
  windowWidth: number;
  /** 校正済み画素値の単位（RescaleType、無ければ CT のみ "HU"、それ以外は ""）。 */
  unit: string;
  /**
   * 適用中の LUT 名（LUT ダイアログの名前。例 `"10_Percent"`）。グレースケール（未適用）なら null。
   * 本体の内部登録名 `graphy-lut-…` / `graphy-gray` は出さない。
   */
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

/** `getPixelData` の任意指定。 */
export interface ViewerPixelDataOptions {
  /**
   * 読み出すスライス（Z）の 0 始まり index。既定は表示中スライス。
   * **範囲外は拒否（null）**＝黙って別のスライスを返さない。
   */
  sliceIndex?: number;
}

/**
 * タイル 1 枚の画素（プラグイン host API の H3）。
 *
 * <p>値は **`pixelCalibration.readModalitySlice()` 経由のモダリティ値**（CT なら HU、
 * SUV 校正済み PET なら SUV）。カラー（RGB）画像は輝度（ITU-R BT.601）で `unit="raw"`。
 * 表示 W/L は掛かっていない（8bit の見た目ではなく定量値）。
 */
export interface ViewerPixelData {
  imageId: string;
  /** 実際に読み出したスライスの index（要求を省略したときは表示中スライス）。 */
  sliceIndex: number;
  /** 行数（height）・列数（width）。`data.length === rows * cols`。 */
  rows: number;
  cols: number;
  /** row-major。`data[y * cols + x]`。 */
  data: Float32Array;
  /** 値の単位（"HU" / "SUVbw" / "" / カラーは "raw"）。 */
  unit: string;
  /**
   * 画素間隔 [列方向(x), 行方向(y), スライス方向(z)] mm。不明な軸は null。
   *
   * <p>z は**スライス間隔**（IPP の差 → SpacingBetweenSlices → SliceThickness の順に導出）。
   * ギャップのある収集では**スライス厚と一致しない**ので、厚さが要る用途では
   * `sliceThickness` を使う。
   */
  spacing: [number | null, number | null, number | null];
  /**
   * DICOM SliceThickness (0018,0050) mm。無ければ null（**間隔で代用しない**）。
   *
   * <p>間隔（`spacing[2]`）とは別物として渡す。RECIST 1.1 の「測定可能病変の最小サイズは
   * スライス厚 >5mm ならその 2 倍」のように、**規約が厚さを指している**用途があり、
   * ギャップのある収集で間隔を厚さの代わりに使うと基準が変わってしまう。
   */
  sliceThickness: number | null;
}

/**
 * 計測レポート（DICOM SR）の保存要求（プラグイン host API の H9）。
 *
 * <p><b>DICOM はプラグインに書かせない</b>。「何を測ったか」だけを渡し、SR の構造は本体（backend）
 * が組み立てる。計測グループは**病変 1 つ**に対応し、時系列で同じ病変を結ぶ `trackingId` を必ず持つ。
 */
export interface ViewerSrRequest {
  /** シリーズ説明（一覧に出る。プラグイン由来なら `[Plugin] ` が前置される）。 */
  seriesDescription?: string;
  /** 文書タイトル（自由文）。 */
  documentTitle?: string;
  /** 観測者名（読影医）。省略可。 */
  observerName?: string;
  /** 計測グループ（病変ごと）。 */
  groups: ViewerSrMeasurementGroup[];
  /** 所見テキスト（経時判定のまとめ等。画像参照を持たない）。 */
  findings?: { label: string; text: string }[];
}

export interface ViewerSrMeasurementGroup {
  /** 病変の追跡 ID（人が読む識別子。**必須**）。 */
  trackingId: string;
  /** 追跡 UID。省略時は backend が採番する。 */
  trackingUid?: string;
  /** 所見の説明（"Target lesion" 等）。 */
  findingText?: string;
  /** 計測した画像（省略時は SR に画像参照が入らない）。 */
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  /**
   * 計測値。**表にある種別のみ**（未知の種別は backend が拒否する＝黙って落とさない）。
   *
   * <p>`unit` を省略すると種別ごとの既定（UCUM）が入る:
   * 長径/短径 `mm` ／ 体積 `mL` ／ 質量 `g` ／ 吸収線量・BED・EQD2 `Gy` ／
   * 時間積分放射能 `Bq.s` ／ 有効半減期 `h`。**換算はしない**（値はそのまま入る）。
   *
   * <p>⚠ 線量系の概念は PS3.16 の標準コードを確認できていないため、
   * **私用コーディングスキームで私用と分かる形**で書かれる（誤った標準コードより害が小さい）。
   */
  measurements: {
    type:
      | "longAxis"
      | "shortAxis"
      | "volume"
      | "mass"
      | "absorbedDose"
      | "timeIntegratedActivity"
      | "effectiveHalfLife"
      | "bed"
      | "eqd2";
    value: number;
    unit?: string;
  }[];
}

/**
 * プラグインが書くアンギオ解析レポート（H37 ／ `fw/angio-design.md` §22.3 の G3）。
 *
 * <p>🔴 **`studyInstanceUid` は受け取らない。** どのスタディに付けるかは**本体が決める**
 * （タイルが表示している検査）。プラグインに指定させると、開いてもいない他患者の検査へ
 * レポートを書けてしまう。同じ理由で、参照する SOP は**開いているタイルの並びの中**に
 * 無ければ拒否する（H10 の「開いているタイルからのみ解決」と同じ考え方）。
 *
 * <p>🔴 **中身は本体の解析ダイアログが出すものと同一**で、書き手も同じ `*SrWriter`。
 * プラグインが渡すのは「何を測ったか」だけで、SR の構造・UID 採番・患者/検査属性の継承は
 * 本体が行う（**DICOM はプラグインに書かせない**＝H4b / H9 と同じ）。
 */
export type ViewerAngioReportRequest =
  | { kind: "qca"; qca: Omit<QcaSrRequest, "studyInstanceUid"> }
  | { kind: "qlv"; qlv: Omit<QlvSrRequest, "studyInstanceUid"> }
  | { kind: "qca3d"; qca3d: Omit<Qca3dSrRequest, "studyInstanceUid"> };

/**
 * プラグインが書く表示状態（GSPS。H38 ／ `fw/angio-design.md` §22.3 の G4）。
 *
 * <p>H37 と同じ制約——**スタディは本体が入れ、参照 SOP が開いている並びに無ければ拒否**する。
 * DSA のマスク・ピクセルシフト・VOI・空間校正・描画を残せる唯一の器なので、
 * 「解析結果を再現できる」ようにするにはこれが要る。
 *
 * <p>⚠️ **読み込み（適用）は本体に残す。** GSPS をビューポートへ当てるのは表示の仕事で、
 * プラグインは当たった結果を H35 / H36 で見れば足りる（校正も DSA も本体が解決した値が来る）。
 */
export type ViewerPresentationStateRequest = Omit<AngioPresentationRequest, "studyInstanceUid">;

export interface ViewerSrResult {
  ok: boolean;
  /** ユーザーが確認ダイアログで拒否した。 */
  cancelled?: boolean;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  error?: string;
}

/**
 * プラグインが表示中スライスへ重ねる値マップ（プラグイン host API の H4a）。
 *
 * <p>**画素ではなく値を渡す契約**にしてある: 色付け（window / colormap）は本体側で行うので、
 * プラグインは RGBA を組み立てる必要がなく、本体の LUT 資産をそのまま使える。
 * `NaN` の画素は**透明**になる（マスクや部分的なマップをそのまま渡せる）。
 */
export interface ViewerOverlay {
  /** rows*cols, row-major。`NaN` は透明。 */
  data: Float32Array;
  /** 現在スライスの rows/cols と一致していること（不一致は拒否）。 */
  rows: number;
  cols: number;
  /** 値 → 濃淡の窓。省略時は data の min/max（NaN 以外）で自動。 */
  window?: { center: number; width: number };
  /** 本体の LUT 名（`/api/luts` の名前。例 "10_Percent"）。省略/null はグレースケール。 */
  colormap?: string | null;
  /** 不透明度 0〜1（既定 0.5）。 */
  opacity?: number;
  /** 出所表示に使うラベル（host がプラグイン名を入れる）。 */
  label?: string;
}

/**
 * プラグインの処理結果を派生シリーズとして保存する要求（プラグイン host API の H4b）。
 *
 * <p>**幾何はプラグインに書かせない**: 各フレームは「元シリーズのどのスライスに対応するか」
 * （`sliceIndex`）だけを申告し、IPP / IOP / PixelSpacing / スライス厚は本体が元シリーズから引き継ぐ。
 * プラグインに座標を組ませると、実空間の意味が壊れた派生シリーズを保管庫に作れてしまう。
 */
export interface ViewerDerivedSeriesRequest {
  /** 新シリーズの説明。保存時に本体が `[Plugin] ` 接頭辞を付ける。 */
  seriesDescription: string;
  /** フレーム（1 枚以上）。`rows`/`cols` は全フレーム共通で、元スライスと一致していること。 */
  frames: Array<{
    /** 元シリーズのスライス index（この結果が対応する元スライス）。 */
    sliceIndex: number;
    /** rows*cols, row-major。`NaN` は「データ無し」として値域の最小値で保存される。 */
    data: Float32Array;
  }>;
  rows: number;
  cols: number;
  /** 値の単位（`RescaleType` に入る。例 "HU"）。省略時は元モダリティ由来の既定。 */
  unit?: string;
  /** 派生内容の説明（`DerivationDescription`）。プラグイン id・版は本体が併記する。 */
  derivationDescription?: string;
  /**
   * `NaN`（データ無し）の画素を埋める値。**`data` に `NaN` を含むなら必須**（含まないなら不要）。
   *
   * <p>既定値は用意しない。かつて「有効値の最小値」を既定にしていたが、閾値マスクでは
   * 有効値がすべて閾値以上なので**背景が閾値そのもの**になり（例: ≧300 HU のマスクで背景が 300 HU）、
   * 「何も無い場所」が骨と同程度の値を持つ誤ったシリーズが出来た。何を背景と呼ぶかは
   * プラグインしか知らないので、**明示させて拒否する**方針にした。
   *
   * <p>この値は DICOM の `PixelPaddingValue` としても書かれるので、ビューア側は
   * 「データ無し」として扱える（W/L の自動計算からも外れる）。CT のマスクなら空気の −1000 が素直。
   */
  background?: number;
}

/** 保存結果。`cancelled` はユーザーが確認ダイアログで拒否した場合。 */
export interface ViewerDerivedSeriesResult {
  ok: boolean;
  cancelled?: boolean;
  seriesInstanceUid?: string;
  instanceCount?: number;
  error?: string;
}

/**
 * ROI 1 件の計測値（プラグイン host API の H5）。**取れない項目は `undefined`**
 * ＝「測っていない」と「0 だった」を区別する（0 で埋めない）。
 *
 * <p>長径・短径が**2 系統ある**のは意図的で、黙って片方を代入しないためである。
 * ユーザーが軸を明示的に引く Bidirectional では `length` / `shortAxis`（＝ユーザーの意図）を、
 * 楕円・矩形・自由曲線では `longAxisMm` / `shortAxisMm`（＝形状から本体が算出）を使う。
 */
export interface ViewerRoiMeasurements {
  /**
   * ツール自身の主計測 (mm)。Length の長さ、Bidirectional の長軸。
   * **画素間隔が無いシリーズでは `undefined`**（Cornerstone は px で計算するため、mm として出さない）。
   */
  length?: number;
  /** Bidirectional の短軸 (mm)。ユーザーが長軸に直交して引いた軸。 */
  shortAxis?: number;
  /**
   * 形状の頂点から本体が算出した最遠 2 点間距離 (mm)＝RECIST の「長径」。
   * 画素間隔が不明なら `undefined`（mm を捏造しない）。算出は `roiRead.computeCalipers()`。
   *
   * <p>**輪郭として意味づけられるツールにだけ出る**（楕円・矩形・自由曲線・Length）。
   * Bidirectional / Angle / Probe では `undefined` になる: Bidirectional は交差する 2 線分で、
   * ハンドル 4 点の最遠距離が**ユーザーが引いた長軸より長くなり得る**ため（短軸を端寄りに引いた場合）。
   * それらのツールでは `length` / `shortAxis` だけが正しい値である。
   */
  longAxisMm?: number;
  /** 上記の長径に**直交**する方向の広がり (mm)＝RECIST の「短径」。全方位の最小幅ではない。 */
  shortAxisMm?: number;
  /** 長径の両端（画素座標）。プラグインが確認表示に使う。 */
  longAxisEnds?: [[number, number], [number, number]];
  /**
   * 面 ROI の面積 (mm²)。**閉多角形（メッシュ）の面積**であって、ラスタ画素数 × 画素面積では
   * ない（両者は境界画素の扱いで数 % ずれる。`fw/roi-stats-design.md` §4.2）。
   * **画素間隔が無いシリーズでは `undefined`**（px² を mm² と偽らない）。
   */
  area?: number;
  /**
   * ROI 内のモダリティ値統計（CT なら HU。表示 W/L は掛かっていない）。
   *
   * <p>🔴 **本体の統計エンジンが出した値**（`viewer/roiStats.ts`）。校正は
   * `pixelCalibration` に一元化されているので、**SUV 校正済みの PET では SUV 値**になる
   * （`unit` も `"SUVbw"` 等になる）。以前は Cornerstone の `cachedStats` を素通ししており、
   * SUV 校正しても Bq/mL のまま流れていた。
   *
   * <p>統計を出せない場合（画素が未ロード・角度など対象外のツール）は
   * **すべて `undefined`**。別経路の値で埋めることはしない
   * ——単位系が黙って混ざる方が有害だから（H35 の「未校正を数値で埋めない」と同じ考え方）。
   */
  mean?: number;
  stdDev?: number;
  min?: number;
  max?: number;
  /**
   * 上記の**統計値**（mean/stdDev/min/max）の単位。取れなければ `undefined`。
   * 長さ・面積の単位ではない（長さは常に mm、面積は mm²）。
   *
   * <p>解決順は **SUV 校正 → RescaleType → モダリティ既定（CT なら "HU"）**。
   * 🔴 **`"raw"` は「校正が無い」という意味**（Rescale も SUV も無い生値）。
   * 定量に使う前に必ず見ること——値だけ見ると HU と区別が付かない。
   */
  unit?: string;
}

/**
 * ROI（計測・幾何注釈）1 件（プラグイン host API の H5）。
 *
 * <p>⚠ **`roiUid` はセッション内でのみ安定**である。本体に ROI の永続化が無く
 * （`fw/roi-manager-design.md` の M5 が未完）、アプリを再起動すると別 UID の別 ROI になる。
 * 時系列で同じ病変を追う（RECIST 等）プラグインは、`roiUid` ではなく
 * **`sopInstanceUid` ＋ `points`（画素座標）＋プラグイン自身が付けた ID** で記録すること。
 */
export interface ViewerRoi {
  /** Cornerstone annotation UID。**セッション内でのみ安定**（上記の注意を参照）。 */
  roiUid: string;
  /** ツール種別（"Length" / "Bidirectional" / "EllipticalROI" / "PlanarFreehandROI" 等）。 */
  tool: string;
  /** ROI マネージャで付けたラベル。未設定なら null。 */
  label: string | null;
  /** 同一患者の判定キー（本体が ROI を永続化する鍵と同じ値）。 */
  patientKey: string;
  /** この ROI が乗っている DICOM インスタンスの識別（時系列で ROI を再同定する鍵）。 */
  studyUid: string;
  /** この ROI が属するスタディの検査日（ISO `YYYY-MM-DD`）。不明なら null。 */
  studyDate: string | null;
  seriesUid: string;
  /** 解決できなければ null。ThickSlab 中は注釈を作れないので通常は取れる。 */
  sopInstanceUid: string | null;
  /** 表示スタック内の 0 始まり index。 */
  sliceIndex: number;
  /**
   * ROI の Z スコープ（`roiMaskStore` のメタ）。
   *
   * <p>⚠ `"all"`（全スライス共通の **global ROI**）の場合、本体は `referencedImageId` を
   * 表示スライスへ追従させる（`globalRoiSync.ts`）ため、**`sliceIndex` / `sopInstanceUid` は
   * 「いまユーザーが見ているスライス」を指すだけで、病変の位置ではない**。
   * 計測を時系列で記録する用途（RECIST 等）では `"all"` の ROI を弾くこと。
   * スコープ未登録は null。
   */
  zScope: number | "all" | null;
  /** ZCT モデルのチャンネル / 時相。 */
  c: number;
  t: number;
  /** 頂点（画像画素座標。x=列, y=行, 0 始まり・サブピクセル可）。 */
  points: Array<[number, number]>;
  /** 面内画素間隔 [列方向(x), 行方向(y)] mm。不明な軸は null。 */
  spacing: [number | null, number | null];
  /** 計測値。 */
  measurements: ViewerRoiMeasurements;
  /** ROI マネージャでの表示 ON/OFF。 */
  visible: boolean;
}

/** 画面（複数タイル）視点での H1 の 1 件。どのタイルの話かが要るので tileId を持つ。 */
export interface ViewerTarget extends ViewerTargetInfo {
  tileId: string;
}

/**
 * 表示中スライスの**空間校正**（プラグイン host API の H35）。
 *
 * <p>🔴 **数値だけでは足りない。** mm/px は `getPixelData().spacing` からも取れるが、
 * それが**実測（カテーテル法）なのか、装置の校正値なのか、幾何近似なのか、未校正なのか**が
 * 分からない。アンギオの設計は「近似には近似と書く」を要求している
 * （`fw/angio-design.md` §7.4）ので、出自を渡さないと**プラグインは正しい注記を書けない**。
 *
 * <p>いまは **XA / XRF でだけ解決する**（`viewer/xaCalibration.ts` の P0〜P7 連鎖）。
 * 他モダリティは `PixelSpacing` をそのまま使う世界で「出自」の概念が無いので **null を返す**
 * ——「校正済み」と嘘をつくより、無いことを伝えるほうがよい。
 */
export interface ViewerSpatialCalibration {
  imageId: string;
  /** 行方向 mm/px。**未校正なら null**（px のまま）。 */
  mmPerPxRow: number | null;
  /** 列方向 mm/px。非等方はそのまま 2 値で渡す（平均して潰さない）。 */
  mmPerPxCol: number | null;
  /** 出自の識別子（`user-catheter` / `dicom-fiducial` / `geometric-sid-sod` / `none` 等）。 */
  source: string;
  confidence: "high" | "medium" | "low" | "none";
  /** 表示の縮退区分。`approximate` なら「近似」と書く義務がある。 */
  tier: "calibrated" | "approximate" | "uncalibrated";
  /** その値が妥当な平面（`fiducial-depth` / `isocenter` / `central-ray` / `detector` / `unknown`）。 */
  plane: string;
  /** 人向けの根拠文字列（そのまま画面に出してよい）。 */
  provenance: string;
  /** 警告の識別子（装置値と 10% 以上ずれている 等）。 */
  warnings: string[];
  /** 未校正のときの検出器面 mm/px（**計測には使わない**。ツールチップ用）。 */
  detectorMmPerPx: number | null;
}

/**
 * XA の表示状態（プラグイン host API の H36）。XA / XRF でなければ null。
 *
 * <p>🔴 **DSA 表示中は画素の意味が変わる。** 差分後は血管が正の大きな値になるので、
 * エッジ検出の向きもプロファイルの意味も反転する。合成 imageId（`graphy-dsa:`）は
 * 元の URL を持たないため、**受け取った側からは見分けられない**（`fw/angio-design.md` §22.3 の G2）。
 */
export interface ViewerXaState {
  imageId: string;
  /** DSA（差分）を表示しているか。 */
  isSubtracted: boolean;
  /** マスクフレーム（0 origin）。差分していなければ空。 */
  maskFrames: number[];
  /** ピクセルシフト [dx, dy]。 */
  shift: [number, number];
  /** 対数変換を掛けているか。 */
  logarithmic: boolean;
  /** `PixelIntensityRelationship (0028,1040)`（LOG / LIN）。読めなければ null。 */
  pixelIntensityRelationship: string | null;
  /** 表示中のフレーム（0 origin）と総数。 */
  frameIndex: number;
  frameCount: number;
}

/** 画面視点での H2。 */
export interface ViewerTileViewState extends ViewerViewState {
  tileId: string;
}

/** 画面視点での H3。 */
export interface ViewerTilePixelData extends ViewerPixelData {
  tileId: string;
}

/** 画面視点での H5。どのタイルで読んだ ROI かが要るので tileId を持つ。 */
export interface ViewerTileRoi extends ViewerRoi {
  tileId: string;
}

/** 画面視点での H35。どのタイルの校正かが要る（tileId 省略時は先頭タイルが答える）。 */
export interface ViewerTileSpatialCalibration extends ViewerSpatialCalibration {
  tileId: string;
}

/** 画面視点での H36。 */
export interface ViewerTileXaState extends ViewerXaState {
  tileId: string;
}

export interface ViewerCommands {
  fit(): void;
  reset(): void;
  rotate90(): void;
  flipH(): void;
  flipV(): void;
  /** 階調反転トグル（カラー画像では no-op）。 */
  invert(): void;
  /** LUT 適用（null でグレースケールに戻す）。 */
  applyLut(lut: LutData | null): void;
  /** 現在適用中の LUT データ（未適用/グレースケールは null）。Fusion への LUT 引き継ぎ用。 */
  getLutData(): LutData | null;
  /** W/L プリセット適用（windowCenter / windowWidth、モダリティ値=HU 等）。 */
  setWindowLevel(center: number, width: number): void;
  /** DICOM 既定ウィンドウ（WindowCenter/Width）に戻す。 */
  resetWindow(): void;
  /** 現在の表示 VOI（モダリティ値=HU 等の中心/幅）と対象 imageId を返す。取得不能なら null。 */
  getWindowState(): { imageId: string; center: number; width: number } | null;
  /** SUV 校正ダイアログ用のコンテキスト（表示中 imageId・SeriesUID・モダリティ）。取得不能なら null。 */
  getSuvContext(): { imageId: string; seriesUid: string; modality: string } | null;
  /** いま表示しているスタディ/シリーズ/スライス。プラグイン host API の H1。取得不能なら null。 */
  getTargetInfo(): ViewerTargetInfo | null;
  /** いまの表示状態（W/L・LUT・反転・affine）。プラグイン host API の H2。取得不能なら null。 */
  getViewState(): ViewerViewState | null;
  /**
   * 表示中スライスの空間校正と**その出自**（H35）。XA / XRF 以外は null。
   * 読み出しは `viewer/xaCalibrationProvider.ts` に委譲する（校正の単一入口）。
   */
  getSpatialCalibration(): ViewerSpatialCalibration | null;
  /** XA の表示状態（DSA・フレーム軸）（H36）。XA / XRF でなければ null。 */
  getXaState(): ViewerXaState | null;
  /**
   * スライス 1 枚の校正済み画素。プラグイン host API の H3。取得不能・範囲外なら null。
   * 読み出しは `pixelCalibration.readModalitySlice()` に委譲する（校正の単一入口）。
   */
  getPixelData(opts?: ViewerPixelDataOptions): Promise<ViewerPixelData | null>;
  /**
   * いま表示しているスタックの imageId を **z 昇順**で返す（プラグイン host API の H31 用）。
   *
   * <p>重畳（H4a）・派生シリーズ保存（H4b）・貸したビューポート（H31）は、いずれも
   * **このスタックのスライス番号**で位置を決める。幾何やメタデータを別の並びから引くと
   * 「ずれた絵」ではなく**「もっともらしいが別スライスの絵」**になり、見て気付けない。
   * 3 者が同じ 1 本の並びを参照するための入口である。
   */
  getStackImageIds(): string[];
  /**
   * 値マップを表示中スライスへ重ねる（H4a）。rows/cols が現在スライスと不一致なら false。
   * 表示中スライスに紐付き、他スライスでは自動的に隠れる（戻ると再表示）。
   */
  showOverlay(overlay: ViewerOverlay): boolean;
  /** オーバーレイを消す（無ければ何もしない）。 */
  clearOverlay(): void;
  /**
   * 保存要求が通るか検証する（H4b）。エラー理由の文字列、問題なければ null。
   * **同意を求める前**に画面側が呼ぶ（通らない要求で確認ダイアログを見せないため）。
   */
  validateDerivedSeries(req: ViewerDerivedSeriesRequest): string | null;
  /**
   * 処理結果を派生シリーズとして保存する（H4b）。**確認は画面側で取ってからここへ来る**
   * （このメソッド自身は同意を取らない）。幾何は元シリーズから引き継ぐ。
   */
  saveDerivedSeries(
    req: ViewerDerivedSeriesRequest,
    producer: { id: string; name: string; version: string },
  ): Promise<ViewerDerivedSeriesResult>;
  /**
   * 計測レポート（DICOM SR）として保存する（H9）。**確認は画面側で取ってからここへ来る**。
   *
   * <p>DICOM の構造・UID 採番・患者/検査属性の引き継ぎは backend が行う。ここは
   * 「どのスタディに付けるか」だけを補って中継する。
   */
  saveStructuredReport(
    req: ViewerSrRequest,
    producer: { id: string; name: string; version: string },
  ): Promise<ViewerSrResult>;
  /**
   * アンギオ解析の結果を **本体と同じ SR** として保存する（H37）。
   * スタディは表示中のものを本体が入れ、参照 SOP がその並びに無ければ拒否する。
   */
  saveAngioReport(
    req: ViewerAngioReportRequest,
    producer: { id: string; name: string; version: string },
  ): Promise<ViewerSrResult>;
  /**
   * 表示状態（XA GSPS）を **本体と同じ器** で保存する（H38）。
   * スタディは本体が入れ、参照 SOP がその並びに無ければ拒否する。
   */
  savePresentationState(
    req: ViewerPresentationStateRequest,
    producer: { id: string; name: string; version: string },
  ): Promise<ViewerSrResult>;
  /**
   * 解析結果を**レポートへ差し込める形で登録する**（H39）。DICOM は書かない。
   * スタディ / シリーズ・id の名前空間・出自・研究用の注記は本体が入れる。
   */
  publishAnalysisResult(
    input: PluginAnalysisInput,
    producer: { id: string; name: string; version: string },
  ): { ok: boolean; error?: string };
  /** 左ドラッグに割り当てる操作/計測/ブラシツールを切替（toolName は Cornerstone のツール名 or 消しゴム id）。 */
  setActiveTool(toolName: string): void;
  /**
   * ROI を選択状態にする（`null` で選択解除）。**ハイライトの実体は Cornerstone の選択**。
   *
   * <p>プラグインの結果一覧から「この ROI はどれか」を示すのに使う。
   * `exclusive` が true（既定）なら他の選択は外す。
   */
  selectRoi(roiUid: string | null, exclusive?: boolean): void;
  /** ROI ブラシ径(px)。 */
  setBrushSize(size: number): void;
  /** 2D Wand のトレランス（シード輝度からの許容差）。 */
  setWandTolerance(tol: number): void;
  /**
   * このタイルが表示中のスタックに乗っている ROI（計測・幾何注釈）を読む（H5）。
   * ROI が無ければ空配列。**呼ぶたびに現在値を読む**（ユーザーは編集を続けるため）。
   */
  getRois(): ViewerRoi[];
  /**
   * ROI に紐付くプラグイン属性を読む（H5）。キーは `plugin.<pluginId>.` を剥がして返す。
   * 未登録なら空オブジェクト。
   */
  getRoiMeta(roiUid: string, pluginId: string): Record<string, string>;
  /**
   * ROI に紐付くプラグイン属性を書く（H5）。キーは `plugin.<pluginId>.` を前置して保存するので、
   * プラグインが本体や他プラグインのキーを踏めない。ROI が存在しなければ false。
   */
  setRoiMeta(roiUid: string, pluginId: string, patch: Record<string, string>): boolean;
  /** 計測（ROI）注釈を全消去。 */
  clearAnnotations(): void;
  undo(): void;
  redo(): void;
}

const registry = new Map<string, ViewerCommands>();

/** tileId をキーにコマンドを登録。返り値で解除。 */
export function registerViewerCommands(key: string, cmds: ViewerCommands): () => void {
  registry.set(key, cmds);
  return () => {
    if (registry.get(key) === cmds) registry.delete(key);
  };
}

/** 対象 tileId 群へ同一コマンドを送出する（未登録キーは無視）。 */
export function runViewerCommand(keys: string[], fn: (c: ViewerCommands) => void): void {
  for (const k of keys) {
    const c = registry.get(k);
    if (!c) continue;
    try {
      fn(c);
    } catch {
      /* ビューポート破棄途中などは無視 */
    }
  }
}

/** 指定キーが登録済みか。 */
export function hasViewerCommands(key: string): boolean {
  return registry.has(key);
}

/** 単一 tileId のコマンドから値を取得する（未登録・例外なら null）。 */
export function queryViewerCommand<T>(key: string, fn: (c: ViewerCommands) => T): T | null {
  const c = registry.get(key);
  if (!c) return null;
  try {
    return fn(c);
  } catch {
    return null;
  }
}
