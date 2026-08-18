/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "./http";
import { apiBase } from "./apiBase";

// apiBase は apiBase.ts へ分離（循環インポート回避）。互換のため再エクスポート。
export { apiBase } from "./apiBase";

export interface AppStatus {
  app: string;
  version: string;
  mode: string;
  activeProfiles: string[];
  javaVersion: string;
  demo?: boolean;
}

export interface Study {
  studyInstanceUid: string;
  patientId: string;
  patientName: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  modality: string | null;
  numberOfInstances: number;
}

export interface Series {
  seriesInstanceUid: string;
  modality: string | null;
  seriesNumber: number | null;
  seriesDescription: string | null;
  /**
   * 代表インスタンスの SOP クラス。「画像として開けるシリーズか」の判定に使う
   * （`viewer/seriesRenderable.ts`）。**web（QIDO）では取れないことがある**ので null 可。
   */
  sopClassUid: string | null;
  numberOfInstances: number;
}

export interface Instance {
  sopInstanceUid: string;
  instanceNumber: number | null;
  sopClassUid: string | null;
}

export interface StudyFilters {
  patientId?: string;
  patientName?: string;
  studyDateFrom?: string;
  studyDateTo?: string;
  modality?: string; // カンマ区切りの複数モダリティ（例 "CT,MR"）
  accessionNumber?: string;
  /** IHE IID 起動: StudyInstanceUID 直接指定（他条件は無視して当該 study を返す）。 */
  studyInstanceUid?: string;
}

export const fetchStatus = () => httpGet<AppStatus>("/api/status");

export const fetchStudies = (filters?: StudyFilters) => {
  const params = new URLSearchParams();
  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v);
    }
  }
  const qs = params.toString();
  return httpGet<Study[]>(`/api/studies${qs ? `?${qs}` : ""}`);
};

export const fetchSeries = (studyUid: string) =>
  httpGet<Series[]>(`/api/studies/${encodeURIComponent(studyUid)}/series`);

export const fetchInstances = (studyUid: string, seriesUid: string) =>
  httpGet<Instance[]>(
    `/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/instances`,
  );

/**
 * web: シリーズ全インスタンスを BFF に WADO-RS 一括取得させてキャッシュに載せる（volume 構築前の高速化）。
 * standalone は no-op（cached:0）。失敗しても呼び出し側は個別取得にフォールバックできる。
 */
export const prefetchSeries = (studyUid: string, seriesUid: string) =>
  httpSend<{ cached: number }>(
    `/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/prefetch`,
    "POST",
  );

/** TagViewer: DICOM 属性ダンプの 1 行（SQ ネストは depth で表現）。 */
export interface TagDumpRow {
  /** シーケンスのネスト深さ（0=トップレベル）。 */
  depth: number;
  /** {@code (gggg,eeee)} 形式のタグ番号。 */
  tag: string;
  /** キーワード（無ければ空）。 */
  name: string;
  vr: string;
  value: string;
}

/** 単一インスタンス（SOP）の属性ダンプを取得する（standalone/web どちらでも動く）。 */
export const fetchInstanceTags = (studyUid: string, seriesUid: string, sopUid: string) =>
  httpGet<TagDumpRow[]>(
    `/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/instances/${encodeURIComponent(sopUid)}/tags`,
  );

/** Encapsulated PDF Storage の SOP Class UID（ピクセル無し＝画像ビューア非対応）。 */
export const ENCAPSULATED_PDF_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.104.1";

/** Video Photographic Image Storage の SOP Class UID（encapsulated 動画）。 */
export const VIDEO_PHOTOGRAPHIC_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.77.1.4.1";

/** encapsulated 動画系 SOP Class（Endoscopic / Microscopic / Photographic）。動画再生の対象判定に使う。 */
export const VIDEO_SOP_CLASSES: ReadonlySet<string> = new Set([
  "1.2.840.10008.5.1.4.1.1.77.1.1.1", // Video Endoscopic Image Storage
  "1.2.840.10008.5.1.4.1.1.77.1.2.1", // Video Microscopic Image Storage
  VIDEO_PHOTOGRAPHIC_SOP_CLASS, // Video Photographic Image Storage
]);

/** SOP Class UID が encapsulated 動画かどうか。 */
export const isVideoSopClass = (sopClassUid: string | null | undefined): boolean =>
  !!sopClassUid && VIDEO_SOP_CLASSES.has(sopClassUid);

/** Encapsulated Document（PDF 等）の中身を配信する URL（inline / download）。 */
export const instanceDocumentUrl = (sopUid: string, download = false) =>
  `${apiBase()}/api/instances/${encodeURIComponent(sopUid)}/document${download ? "?download=true" : ""}`;

/**
 * encapsulated 動画を {@code video/mp4} として配信する URL（standalone のみ。Range 対応）。
 * {@code <video>} の src / Cornerstone VideoViewport のメタデータプロバイダから参照する。
 */
export const videoRenderedUrl = (sopUid: string) =>
  `${apiBase()}/api/instances/${encodeURIComponent(sopUid)}/rendered`;

/** 動画諸元（backend がヘッダから導出）。再生 UI とフレーム換算に使う。 */
export interface VideoMetadata {
  rows: number;
  columns: number;
  numberOfFrames: number;
  /** 1 秒あたりフレーム数（FrameTime 優先、無ければ CineRate。不明なら 0）。 */
  fps: number;
  frameTimeMs: number | null;
  cineRate: number | null;
  durationSec: number | null;
  transferSyntaxUid: string | null;
  /** true の場合、転送構文から見てブラウザ非対応のため配信には サーバ側の ffmpeg 変換が必要。 */
  transcodeRequired: boolean;
  /**
   * サーバ側で変換できるか（ffmpeg があるか）。P4 以降 `/rendered` は MPEG2 等も変換して配信するので、
   * **`transcodeRequired && !transcodeAvailable` の時だけ**再生不可の案内を出す。
   */
  transcodeAvailable: boolean;
}

/** 動画諸元を取得する（standalone）。 */
export const fetchVideoMetadata = (sopUid: string) =>
  httpGet<VideoMetadata>(`/api/instances/${encodeURIComponent(sopUid)}/video-metadata`);

export interface SeriesLayoutCell {
  c: number;
  z: number;
  t: number;
  sopInstanceUid: string;
  /** Siemens モザイクのタイル番号（0..N-1）。非モザイクは -1。 */
  frame?: number;
}

/** Z インデックスごとの ImagePositionPatient（Fusion trilinear 補間用）。 */
export interface SeriesLayoutZSpatial {
  z: number;
  imagePositionPatient: [number, number, number];
}

/**
 * ボクセルあたりのバイト数を決めるピクセル形式（ボリューム構築前のメモリ量予測用。
 * `fw/volume-memory-guard.md` §2.1）。BitsAllocated だけでは型が決まらないため rescale も含む。
 */
export interface SeriesPixelFormat {
  bitsAllocated: number;
  /** 1 = signed。 */
  pixelRepresentation: number;
  /** RGB なら 3。 */
  samplesPerPixel: number;
  rescaleSlope: number;
  rescaleIntercept: number;
}

/** シリーズの 5D(ZCT) レイアウト（backend がヘッダから導出）。 */
export interface SeriesLayoutDto {
  nZ: number;
  nC: number;
  nT: number;
  cDimension: string | null;
  tDimension: string | null;
  cells: SeriesLayoutCell[];
  /** IOP 6 要素（行/列方向余弦）。Fusion 精密アライメント用。null なら未取得。 */
  imageOrientationPatient: [number, number, number, number, number, number] | null;
  /** 行間隔 [mm]。0 なら未取得。 */
  pixelSpacingRow: number;
  /** 列間隔 [mm]。0 なら未取得。 */
  pixelSpacingCol: number;
  imageWidth: number;
  imageHeight: number;
  /** Z インデックスごとの IPP リスト（z 昇順）。null なら未取得。 */
  zSpatial: SeriesLayoutZSpatial[] | null;
  /** FrameOfReferenceUID。セグメンテーション labelmap のメタデータ供給／volume 再構成の FoR 判定用。null なら未取得。 */
  frameOfReferenceUID: string | null;
  /** ピクセル形式。ボリューム構築前のメモリ量予測用。null なら未取得（予測をスキップする）。 */
  pixelFormat?: SeriesPixelFormat | null;
  /** 軸の提示とスタック軸。null なら既定（Z/C/T・stackAxis="z"）＝ CT/MR の従来動作。`fw/angio-design.md` §5.7。 */
  axes?: SeriesAxesDto | null;
}

/** 1 つの軸の提示（UI ラベルと種別）。 */
export interface SeriesAxisDto {
  /** UI に出すラベル（"Z" / "Run" / "Frame" 等）。 */
  label: string;
  /** 軸の種別。UI は空間スライス軸前提の機能（ThickSlab/Sync/参照線）の可否をこれで決める。 */
  kind: "slice" | "run" | "frame" | "echo" | "bvalue" | "temporal" | "generic";
}

/** 軸の提示モデル（`fw/angio-design.md` §5.7）。 */
export interface SeriesAxesDto {
  z: SeriesAxisDto | null;
  c: SeriesAxisDto | null;
  t: SeriesAxisDto | null;
  /** 画像スタック（ホイール送り／Grid／プリフェッチの単位）をどの軸に割り当てるか。 */
  stackAxis: "z" | "t";
}

export interface TagInfo {
  tag: string;
  keyword: string;
  vr: string;
}

/** タグ番号(8桁hex) → keyword/VR（dcm4che 辞書）。 */
export const fetchTagInfo = (tag: string) =>
  httpGet<TagInfo>(`/api/dicom/tag?tag=${encodeURIComponent(tag)}`);

export const fetchSeriesLayout = (studyUid: string, seriesUid: string) =>
  httpGet<SeriesLayoutDto>(
    `/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/layout`,
  );

// ── アンギオの解析結果の保存（GSPS / QCA SR）。`fw/angio-design.md` §14 / A10 ──────

/** XA/XRF GSPS 作成要求。座標は画像ピクセル座標（0 origin）、フレーム番号は 1 origin。 */
export interface AngioPresentationRequest {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  frameNumbers?: number[] | null;
  label?: string | null;
  description?: string | null;
  creator?: string | null;
  voi?: { windowCenter: number; windowWidth: number } | null;
  invert?: boolean | null;
  rotation?: number | null;
  flipHorizontal?: boolean | null;
  mask?: {
    maskFrameNumbers: number[];
    subPixelShiftRow?: number | null;
    subPixelShiftCol?: number | null;
    operation?: string | null;
  } | null;
  calibration?: {
    mmPerPxRow?: number | null;
    mmPerPxCol?: number | null;
    type?: string | null;
    description?: string | null;
  } | null;
  polylines?: { layer: string; points: number[]; filled?: boolean; rgb?: number[] | null }[];
  texts?: { layer: string; text: string; anchorX: number; anchorY: number }[];
}

export interface QcaSrRequest {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  frameNumber?: number | null;
  unit: string;
  calibration?: string | null;
  vesselLabel?: string | null;
  /**
   * 手修正の内容（"中間点 2 / エッジ 5 点 / 参照径=健常部指定"）。全自動なら null。
   * 手で直した値を自動値と同じ顔で保存しないための項目（`fw/angio-design.md` §8.6）。
   */
  manualCorrection?: string | null;
  /**
   * 径を何で測ったか（`"half-max"` / `"densitometric"`）。省略時は半値法として扱う。
   * 🚨 **数値だけ残して測り方を落とさない**（`fw/angio-design.md` §16.5）。
   * 半値法と密度計測では絶対値が 10% 以上違ううえ、密度計測のときは
   * **画面の輪郭（半値法）と数値が別方式**になる。
   */
  diameterMethod?: string | null;
  mld: number;
  rvd: number;
  percentDiameterStenosis: number;
  percentAreaStenosis: number;
  lesionLength: number;
}

export interface AngioCreated {
  seriesInstanceUid: string;
  sopInstanceUid: string;
}

/** 表示状態（DSA 設定・VOI・計測描画・空間校正）を XA/XRF GSPS として保存する。 */
export const createXaPresentationState = (req: AngioPresentationRequest) =>
  httpSend<AngioCreated>("/api/angio/presentation-state", "POST", req);

/** QCA 計測値を Comprehensive SR として保存する。 */
export const createQcaSr = (req: QcaSrRequest) => httpSend<AngioCreated>("/api/angio/qca-sr", "POST", req);

/**
 * QVA（末梢・脳血管）の計測値を Comprehensive SR として保存する（§9.1 / A5a）。
 *
 * <p>QCA と別の要求にしているのは、**瘤の指標と、瘤に付く限界（投影 1 方向）**が
 * 増えるため。QCA の SR に瘤の項目を混ぜると、冠動脈の SR に空の瘤欄が並ぶ。
 */
export const createQvaSr = (req: QvaSrRequest) => httpSend<AngioCreated>("/api/angio/qva-sr", "POST", req);

export interface QvaSrRequest {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  frameNumber?: number | null;
  unit: string;
  calibration?: string | null;
  vesselLabel?: string | null;
  manualCorrection?: string | null;
  mld: number;
  rvd: number;
  percentDiameterStenosis: number;
  lesionLength: number;
  /** 拡張（瘤）。無ければ null（**空欄を 0 で埋めない**）。 */
  dilation?: {
    maxDiameter: number;
    ratio: number;
    percentDilation: number;
    length: number;
    proximalNeck: number;
    distalNeck: number;
    /** 測れなければ null。 */
    eccentricity?: number | null;
    aneurysmal: boolean;
  } | null;
}

/**
 * QLV（左室造影）の結果を保存する要求（`fw/angio-design.md` §9.2 / A5b）。
 *
 * 🚨 **未校正のときは `unit`・容積・Kennedy をすべて null にする**。EF はスケール不変なので
 * 未校正でも正しいが、容積の絶対値と Kennedy 補正（アフィン変換）は出せない（§9.2.1）。
 */
export interface QlvSrRequest {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  /** **1 origin**。 */
  edFrameNumber: number;
  esFrameNumber: number;
  /** 校正済みなら "mL"、未校正なら null。 */
  unit: string | null;
  calibration?: string | null;
  /** "manual" / "automatic (area curve)"。ED/ES の決め方は結果の意味を変える（§9.2.2）。 */
  frameSelection: string;
  ejectionFraction: number;
  edvMl: number | null;
  esvMl: number | null;
  kennedyEdvMl: number | null;
  kennedyEsvMl: number | null;
  kennedyEjectionFraction: number | null;
  method: string;
}

/** QLV 計測値を Comprehensive SR として保存する。 */
export const createQlvSr = (req: QlvSrRequest) => httpSend<AngioCreated>("/api/angio/qlv-sr", "POST", req);

/**
 * 3D QCA の結果を保存する要求（`fw/angio-design.md` §10 / A6a）。
 *
 * 🚨 **2 方向の両方を渡す**。3D の値はどの 2 方向から作ったかで変わるので、片方だけでは再現できない。
 * 🚨 **未校正なら `minAreaMm2` / `minEquivalentDiameterMm` / `calibration` を null にする**。
 * 長さは幾何（SID/SOD と検出器ピッチ）だけで決まるので校正に依らないが、断面は径から作るため出せない。
 */
export interface Qca3dSrRequest {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  viewASopInstanceUid: string;
  /** **1 origin**。 */
  viewAFrameNumber: number;
  viewBSopInstanceUid: string;
  viewBFrameNumber: number;
  separationDeg: number;
  /** 3 未満なら角度補正が掛かっていない（§10.2.2）。 */
  anchorCount: number;
  anchorReprojectionPx: number;
  angleCorrected: boolean;
  lengthMm: number;
  minAreaMm2: number | null;
  minEquivalentDiameterMm: number | null;
  /** 見えている長さの割合（短縮の指標。§10.2.5）。 */
  visibleFractionA: number | null;
  visibleFractionB: number | null;
  calibration: string | null;
  /** 狭窄率は比なので半値法の系統誤差がほぼ打ち消される。MLD/RVD の絶対値には残る。 */
  percentDiameterStenosis: number | null;
  percentAreaStenosis: number | null;
  mldMm: number | null;
  rvdMm: number | null;
  lesionLengthMm: number | null;
}

/** 3D QCA の結果を Comprehensive SR として保存する。 */
export const createQca3dSr = (req: Qca3dSrRequest) =>
  httpSend<AngioCreated>("/api/angio/qca3d-sr", "POST", req);

// ── 被ばく線量レポート（RDSR）。`fw/angio-design.md` §14.2 / A9 ────────────────

/** SR の 1 項目（NUM / TEXT / CODE / UIDREF / DATETIME）。 */
export interface DoseItem {
  /** ConceptNameCodeSequence の CodeValue。無ければ null。 */
  code: string | null;
  /** 同 CodeMeaning。突き合わせはこちらで行う（装置ごとのコード表差に強い）。 */
  meaning: string | null;
  valueType: string;
  numericValue: number | null;
  unit: string | null;
  textValue: string | null;
}

/** 1 回の照射イベント。 */
export interface IrradiationEvent {
  index: number;
  eventType: string | null;
  eventUid: string | null;
  items: DoseItem[];
}

export interface DoseReport {
  sopInstanceUid: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  contentDateTime: string | null;
  manufacturer: string | null;
  accumulated: DoseItem[];
  events: IrradiationEvent[];
}

export interface StudyDoseDto {
  studyInstanceUid: string;
  reports: DoseReport[];
  summary: {
    doseAreaProductTotal: number | null;
    doseRpTotal: number | null;
    fluoroTimeTotal: number | null;
    irradiationEventCount: number;
  };
}

/** 検査に含まれる RDSR を解析して返す。RDSR が無ければ reports は空配列（404 にはならない）。 */
export const fetchStudyDose = (studyUid: string) =>
  httpGet<StudyDoseDto>(`/api/studies/${encodeURIComponent(studyUid)}/dose`);

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export const importPaths = (paths: string[]) =>
  httpSend<ImportResult>("/api/import/paths", "POST", { paths });

// ── NonDicomImport（PDF/画像/動画を DICOM 化して取込） ───────────

export interface NonDicomRequest {
  paths: string[];
  patientId: string;
  patientName?: string;
  patientBirthDate?: string;
  patientSex?: string;
  /** 既存スタディに追加する場合に指定。空なら新規スタディを採番。 */
  studyInstanceUid?: string;
  studyDescription?: string;
  accessionNumber?: string;
  seriesDescription?: string;
}

export interface NonDicomFileOutcome {
  filename: string;
  /** imported | skipped | failed */
  status: string;
  sopClass: string;
  message: string;
}

export interface NonDicomResult {
  imported: number;
  skipped: number;
  failed: number;
  studyInstanceUid: string;
  files: NonDicomFileOutcome[];
}

/** 非 DICOM ファイルを DICOM 化して取り込む（standalone のローカル FS 前提）。 */
export const importNonDicom = (req: NonDicomRequest) =>
  httpSend<NonDicomResult>("/api/import/nondicom", "POST", req);

// ── NIfTI インポート（standalone のローカル FS 前提） ──────────────

/** NIfTI ヘッダの下読み結果。取り込み前に次元と幾何の出所を見せるために使う。 */
export interface NiftiProbe {
  columns: number;
  rows: number;
  slices: number;
  /** 時相数（4D なら 2 以上）。 */
  phases: number;
  channels: number;
  spacingX: number;
  spacingY: number;
  spacingZ: number;
  datatype: number;
  /** 画素の変換方法（例 "int16 → 16bit signed"）。 */
  pixelConversion: string | null;
  /** 幾何の出所（"sform" / "qform" / "pixdim"）。 */
  geometrySource: string | null;
  /**
   * 患者座標が無く幾何を合成したか。**true のときは向きが本物ではない**ので、
   * UI で必ず警告すること。
   */
  geometrySynthesized: boolean;
  description: string | null;
  supported: boolean;
  error: string | null;
}

export interface NiftiImportRequest {
  path: string;
  /** サイドカー JSON（dcm2niix / BIDS）。任意。 */
  metadataPath?: string;
  modality?: string;
  patientId?: string;
  patientName?: string;
  patientBirthDate?: string;
  patientSex?: string;
  studyDate?: string;
  studyDescription?: string;
  seriesDescription?: string;
  seriesNumber?: number;
  studyInstanceUid?: string;
}

export interface NiftiImportResult {
  imported: number;
  failed: number;
  slices: number;
  phases: number;
  channels: number;
  rows: number;
  columns: number;
  geometrySource: string | null;
  geometrySynthesized: boolean;
  studyInstanceUid: string | null;
  seriesInstanceUid: string | null;
  /** サイドカー JSON から写せた属性の数。 */
  metadataApplied: number;
  pixelConversion: string | null;
  /** アフィンのスケールが pixdim と食い違い、pixdim の実寸を採ったときの説明。 */
  spacingNote: string | null;
  error: string | null;
}

/** NIfTI のヘッダだけ読む（取り込みはしない）。 */
export const probeNifti = (path: string) =>
  httpSend<NiftiProbe>("/api/nifti/probe", "POST", { path });

/** NIfTI を DICOM 化して保管庫へ取り込む。 */
export const importNifti = (req: NiftiImportRequest) =>
  httpSend<NiftiImportResult>("/api/nifti/import", "POST", req);

// ── LUT ────────────────────────────────────────────────────────

export interface LutData {
  name: string;
  /** 赤チャンネル 0-255（256 要素）。 */
  r: number[];
  /** 緑チャンネル 0-255（256 要素）。 */
  g: number[];
  /** 青チャンネル 0-255（256 要素）。 */
  b: number[];
}

/** classpath の luts/ にある LUT 名の一覧を取得する。 */
export const fetchLutNames = () => httpGet<string[]>("/api/luts");

/** 指定名の LUT RGB データを取得する。 */
export const fetchLutData = (name: string) =>
  httpGet<LutData>(`/api/luts/${encodeURIComponent(name)}`);

// ── TagExtractor（タグ一括抽出: シーケンス/Private 対応・検索リスト全体・テーブル/CSV） ──

/** 標準 DICOM タグ辞書の 1 エントリ。 */
export interface TagDictEntry {
  /** 8 桁 hex（例 "00100010"）。 */
  tag: string;
  keyword: string;
  vr: string;
}

/** 標準 DICOM タグ辞書一覧を取得する（辞書検索・SQ 判定用、起動後キャッシュ）。 */
export const fetchTagDictionary = () => httpGet<TagDictEntry[]>("/api/dicom/tags");

/** タグパスの 1 セグメント。tag=8桁hex、creator=Private creator（任意）。 */
export interface TagPathSegment {
  tag: string;
  creator?: string;
}

/** 抽出する 1 つのタグパス（セグメント列＋表示ラベル）。単一タグは segments 長 1。 */
export interface TagPath {
  segments: TagPathSegment[];
  label: string;
}

export interface ExtractRequest {
  /** 対象＝検索リスト全体のスタディ UID 群。 */
  studyUids: string[];
  paths: TagPath[];
}

/** 画面テーブル用の抽出結果（列＋行＋エラーログ）。 */
export interface ExtractTableResult {
  columns: string[];
  rows: string[][];
  errors: string[];
}

/** 検索リスト全体をシリーズ単位で抽出し、テーブル（列/行/エラー）を返す。 */
export const extractTable = (req: ExtractRequest) =>
  httpSend<ExtractTableResult>("/api/extract/table", "POST", req);

/** 同一条件で CSV を取得（Blob＋ファイル名）。http ラッパは JSON 前提のため直接 fetch。 */
export const extractCsv = async (req: ExtractRequest): Promise<{ blob: Blob; filename: string }> => {
  const res = await fetch(`${apiBase()}/api/extract/csv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename="?([^"]+)"?/.exec(cd);
  const filename = m ? m[1] : "tags.csv";
  return { blob, filename };
};

// ── Export（DICOM 交換メディア ZIP） ──────────────────────────

/** 1 スタディと、その中で Export 対象に選択されたシリーズ。 */
export interface ExportSelection {
  studyUid: string;
  seriesUids: string[];
}

export interface ExportRequest {
  selections: ExportSelection[];
  /** DICOMDIR を同梱する（portable viewer ON 時は backend 側で強制 ON）。 */
  includeDicomDir: boolean;
  /** portable 2D viewer を同梱する（DICOMDIR を必須化）。 */
  includePortableViewer: boolean;
  /** README.txt を同梱する。 */
  includeReadme: boolean;
}

/**
 * 選択シリーズを PS3.10 階層（＋任意で DICOMDIR/README）の ZIP として取得する。
 * TagExtractor と同じく blob 受信＋ファイル名抽出（http ラッパは JSON 前提のため不使用）。
 */
export const exportZip = async (
  req: ExportRequest,
): Promise<{ blob: Blob; filename: string }> => {
  const res = await fetch(`${apiBase()}/api/export/zip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename="?([^"]+)"?/.exec(cd);
  const filename = m ? m[1] : "graphy-export.zip";
  return { blob, filename };
};

// ── ImageJ ROI 入出力 ────────────────────────────────

/** ImageJ ROI 交換 DTO（backend {@code ImageJRoiDto} と一致。画像ピクセル座標）。 */
export interface ImageJRoiDto {
  name?: string;
  type: string; // polygon | freehand | polyline | oval | rect | point | angle
  position: number; // スライス位置（1-based, 0=未指定）
  xs?: number[];
  ys?: number[];
  bx?: number;
  by?: number;
  bw?: number;
  bh?: number;
  strokeColor?: number; // 0xAARRGGBB
}

/** ROI 群 → RoiSet.zip（blob＋ファイル名）。 */
export const exportImageJRoiSet = async (
  rois: ImageJRoiDto[],
): Promise<{ blob: Blob; filename: string }> => {
  const res = await fetch(`${apiBase()}/api/imagej/roiset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rois),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename="?([^"]+)"?/.exec(cd);
  return { blob, filename: m ? m[1] : "RoiSet.zip" };
};

// --- DICOM SEG 書き出し（マスク→Segmentation, fw/dicom-seg-rtstruct-design.md S1）---
export interface SegExportFrame {
  sopInstanceUid: string;
  imagePositionPatient: [number, number, number];
  mask: string; // rows*cols の 0/1 バイト列を Base64
}
export interface SegExportSegment {
  number: number;
  label: string;
  color: [number, number, number] | null;
  description?: string | null;
  frames: SegExportFrame[];
}
export interface SegExportRequest {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  rows: number;
  columns: number;
  imageOrientationPatient: number[];
  pixelSpacing: [number, number]; // [row, col]
  sliceThickness: number;
  frameOfReferenceUID?: string | null;
  seriesDescription?: string | null;
  segments: SegExportSegment[];
}
export interface SegExportResult {
  seriesInstanceUid: string;
  sopInstanceUid: string;
}
/** マスク群を DICOM SEG として保存し、新シリーズ UID を返す。 */
export const exportDicomSeg = (req: SegExportRequest) =>
  httpSend<SegExportResult>("/api/dicom/seg", "POST", req);

// --- RTSTRUCT 書き出し（2D ベクタ ROI→RT Structure Set, S2）---
export interface RtStructContour {
  sopInstanceUid: string;
  points: number[]; // [x,y,z,x,y,z,...] 患者座標 mm（閉輪郭）
}
export interface RtStructRoi {
  number: number;
  name: string;
  color: [number, number, number] | null;
  type?: string | null;
  contours: RtStructContour[];
}
export interface RtStructExportRequest {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  frameOfReferenceUID: string;
  structureSetLabel?: string | null;
  rois: RtStructRoi[];
}
/** 2D ベクタ ROI 群を DICOM RTSTRUCT として保存し、新シリーズ UID を返す。 */
export const exportDicomRtStruct = (req: RtStructExportRequest) =>
  httpSend<SegExportResult>("/api/dicom/rtstruct", "POST", req);

// --- RTSTRUCT 読込（S3: 輪郭→ROI 復元）---
export interface RtStructImportContour {
  referencedSopInstanceUid: string | null;
  points: number[]; // [x,y,z,...] 患者座標 mm
}
export interface RtStructImportRoi {
  name: string;
  color: number[] | null; // [r,g,b]
  type: string | null;
  contours: RtStructImportContour[];
}
/** 指定 RTSTRUCT シリーズを読み、ROI 輪郭群を返す。 */
export const readDicomRtStruct = (studyUid: string, seriesUid: string) =>
  httpGet<RtStructImportRoi[]>(
    `/api/dicom/rtstruct?study=${encodeURIComponent(studyUid)}&series=${encodeURIComponent(seriesUid)}`,
  );

// --- SEG 読込（マスク駆動パイプライン導線: fw/mask-driven-pipelines-gap-analysis.md 課題#2）---
export interface SegImportFrame {
  referencedSopInstanceUid: string | null;
  imagePositionPatient: [number, number, number] | null;
  mask: string; // rows*columns の 0/1 バイト列を Base64
}
export interface SegImportSegment {
  number: number;
  label: string;
  color: [number, number, number] | null;
  description: string | null;
  frames: SegImportFrame[];
}
export interface SegImportResult {
  rows: number;
  columns: number;
  segments: SegImportSegment[];
}
/** 指定 SEG シリーズを読み、セグメント毎のマスク平面群を返す。 */
export const readDicomSeg = (studyUid: string, seriesUid: string) =>
  httpGet<SegImportResult>(
    `/api/dicom/seg?study=${encodeURIComponent(studyUid)}&series=${encodeURIComponent(seriesUid)}`,
  );

/**
 * セグメントの見出しだけを読む（`frames` は空で返る）。
 *
 * マスク平面はセグメントあたり 512×512×スライス数の Base64 になるので、名前を出すためだけに
 * `readDicomSeg` を呼ばないこと。**セグメントは番号の昇順**で、i 番目がシリーズの
 * チャンネル (C) i に対応する（backend `SegFrameExpander` が番号の rank を C にしている）。
 */
export const readDicomSegSegments = (studyUid: string, seriesUid: string) =>
  httpGet<SegImportResult>(
    `/api/dicom/seg/segments?study=${encodeURIComponent(studyUid)}&series=${encodeURIComponent(seriesUid)}`,
  );

export interface DeleteSeriesResult {
  deletedInstances: number;
}
/** シリーズを削除（standalone のローカル DB 管理専用。web モードでは索引が空で実質no-op）。 */
export const deleteSeries = (studyUid: string, seriesUid: string) =>
  httpSend<DeleteSeriesResult>(
    `/api/series/${encodeURIComponent(studyUid)}/${encodeURIComponent(seriesUid)}`,
    "DELETE",
  );

/** .roi/.zip をアップロードして DTO 群にデコード。 */
export const importImageJRoiSet = async (file: File): Promise<ImageJRoiDto[]> => {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${apiBase()}/api/imagej/import`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** ブリッジ結果（次元）。 */
export interface ImageJBridgeResult {
  nZ: number;
  nC: number;
  nT: number;
  width: number;
  height: number;
}

/** 表示中シリーズを ImageJ の HyperStack として開く（ローカル ImageJ 起動）。 */
export const bridgeImageJHyperStack = (
  studyUid: string,
  seriesUid: string,
  title?: string,
): Promise<ImageJBridgeResult> =>
  httpSend<ImageJBridgeResult>("/api/imagej/bridge", "POST", { studyUid, seriesUid, title });

// ── Texture（Radiomics 可視化マップ） ────────────────────────────
/** Texture マップ生成リクエスト（backend: POST /api/series/texture）。 */
export interface TextureMapRequest {
  studyInstanceUid: string;
  sourceSeriesUid: string;
  /** マスクシリーズ（任意, 未指定で全面マスク）。 */
  maskSeriesUid?: string | null;
  /** マスクの C インデックス（DICOM SEG マルチセグメント時の選択, 既定 0）。 */
  maskChannel: number;
  /** "GLCM_JointEntropy" 等（"FAMILY_FeatureName"）。 */
  feature: string;
  /** カーネル径（奇数）。 */
  filterSize: number;
  /** x,y,z 共通ストライド（1=等倍）。 */
  stride: number;
  /** true=2D パッチ, false=3D パッチ。 */
  force2D: boolean;
  /** マルチ次元スタックの C インデックス（既定 0）。 */
  channel: number;
  /** マルチ次元スタックの T インデックス（既定 0）。 */
  timePoint: number;
  /** Radiomics パラメータ（GRAPHY Property キー→文字列値）。 */
  settings: Record<string, string>;
  /**
   * 窓を切り出す前に ROI を広げるボクセル数（未指定で RadiomicsJ 既定の 3）。
   * ROI 端のボクセルは窓が部分的にしか埋まらず、テクスチャの違いではなく「読んだ画素が
   * 少ない」という理由だけで値がずれる。それを埋めるための余白。0 で 2.3.0 以前の挙動。
   */
  margin?: number | null;
  seriesDescription?: string | null;
  seriesNumber?: number | null;
}
export interface TextureMapResult {
  seriesInstanceUid: string;
  sopInstanceUids: string[];
}
/**
 * Texture 可視化マップを計算し派生シリーズとして保存する（**終わるまで待つ**）。
 * UI からは {@link submitTextureJob} を使う。マップ計算は分単位になりうる。
 */
export const createTextureMap = (req: TextureMapRequest) =>
  httpSend<TextureMapResult>("/api/series/texture", "POST", req);

export type TextureJobState = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

/** Texture 計算ジョブの状態（backend: TextureJobService.Status）。 */
export interface TextureJobStatus {
  jobId: string;
  state: TextureJobState;
  feature: string;
  slicesDone: number;
  slicesTotal: number;
  elapsedMs: number;
  result?: TextureMapResult | null;
  error?: string | null;
}

/** 計算を投入する。返るのは「まだ何も起きていない」状態。 */
export const submitTextureJob = (req: TextureMapRequest) =>
  httpSend<TextureJobStatus>("/api/series/texture/jobs", "POST", req);

/** 進み具合と、終わっていれば結果。 */
export const getTextureJob = (jobId: string) =>
  httpGet<TextureJobStatus>(`/api/series/texture/jobs/${encodeURIComponent(jobId)}`);

/** キャンセルを頼む。実際に止まるのは走っているスライスが終わったところ。 */
export const cancelTextureJob = (jobId: string) =>
  httpSend<TextureJobStatus>(`/api/series/texture/jobs/${encodeURIComponent(jobId)}`, "DELETE");

// ── Anonymizer（PS3.15 匿名化） ────────────────────────────────

/** 匿名化オプション（backend AnonymizeConfig.Option 名と一致）。 */
export type AnonOption =
  | "CleanPixelData"
  | "CleanRecognizableVisualFeatures"
  | "CleanGraphics"
  | "CleanStructuredContent"
  | "CleanDescriptors"
  | "RetainLongitudinalTemporalInformationFullDates"
  | "RetainLongitudinalTemporalInformationModifiedDates"
  | "RetainPatientCharacteristics"
  | "RetainDeviceIdentity"
  | "RetainUIDs"
  | "RetainSafePrivate"
  | "RetainInstitutionIdentity";

export interface AnonProfile {
  name: string;
  options: AnonOption[];
}

export interface AnonRequest {
  studyUids: string[];
  options: AnonOption[];
  replacePatientName: string;
  replacePatientId: string;
  randomSeed?: number | null;
  /** 個別保持タグ（8桁hex）。 */
  manualRetainTags?: string[];
  /** 個別カスタムダミー値（hex→値）。 */
  customReplacements?: Record<string, string>;
  /** Clean Pixel Data の焼き込みを実行するか（登録済みマスク使用）。 */
  burnIn: boolean;
  /** standalone copy の出力先絶対パス。 */
  destination?: string;
}

export interface AnonResult {
  studies: number;
  series: number;
  instances: number;
  burnedInstances: number;
  errors: string[];
}

/** 焼き込みマスク（画像ピクセル矩形）。frames 空=全フレーム/全インスタンス。 */
export interface AnonSeriesMask {
  seriesUid: string;
  frames: number[];
  rects: { x: number; y: number; w: number; h: number }[];
}

export const fetchAnonProfiles = () => httpGet<AnonProfile[]>("/api/anonymizer/profiles");

/** 匿名化して ZIP を取得（standalone のローカルファイル）。 */
export const anonymizeZip = async (req: AnonRequest): Promise<{ blob: Blob; filename: string }> => {
  const res = await fetch(`${apiBase()}/api/anonymizer/zip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename="?([^"]+)"?/.exec(cd);
  return { blob, filename: m ? m[1] : "anonymized.zip" };
};

/** standalone: 匿名化してフォルダへ書き出す。 */
export const anonymizeCopy = (req: AnonRequest) =>
  httpSend<AnonResult>("/api/anonymizer/copy", "POST", req);

/** 焼き込みマスクを登録（2D viewer から）。 */
export const registerAnonMask = (mask: AnonSeriesMask) =>
  httpSend<void>("/api/anonymizer/masks", "POST", mask);

/** 登録済み焼き込みマスクを取得。 */
export const fetchAnonMasks = (seriesUids: string[]) =>
  httpGet<AnonSeriesMask[]>(`/api/anonymizer/masks?seriesUids=${encodeURIComponent(seriesUids.join(","))}`);

/** 焼き込みマスクを削除（seriesUid 省略で全消去）。 */
export const clearAnonMask = (seriesUid?: string) =>
  httpSend<void>(`/api/anonymizer/masks${seriesUid ? `?seriesUid=${encodeURIComponent(seriesUid)}` : ""}`, "DELETE");

// ── SeriesExtractor（条件一致シリーズをフォルダ抽出/ZIP） ───────

/** シリーズ抽出の 1 条件。op: EQUALS | CONTAINS | GE | LE | RANGE。 */
export interface SeriesCondition {
  segments: TagPathSegment[];
  vr: string;
  exclude: boolean;
  op: string;
  value1: string;
  value2: string;
}

/** 条件に一致した 1 シリーズ。 */
export interface SeriesMatch {
  studyUid: string;
  seriesUid: string;
  patientId: string;
  studyDate: string;
  seriesDescription: string;
  modality: string;
  instances: number;
  folderName: string;
}

export interface SeriesVerifyResult {
  matched: SeriesMatch[];
  studyCount: number;
  seriesCount: number;
  errors: string[];
}

export interface SeriesCopyResult {
  copiedSeries: number;
  copiedFiles: number;
  folders: string[];
  errors: string[];
}

export interface SeriesExtractRequest {
  studyUids: string[];
  conditions: SeriesCondition[];
  /** 平面フィルタ（AXIAL/SAGITTAL/CORONAL）。空/未指定で無効。 */
  planes?: string[];
  /** コピー先の絶対パス（standalone の copy のみ）。 */
  destination?: string;
  sequentialRename?: boolean;
}

/** 条件に一致するシリーズを検証（プレビュー）。 */
export const seriesExtractVerify = (req: SeriesExtractRequest) =>
  httpSend<SeriesVerifyResult>("/api/series-extract/verify", "POST", req);

/** standalone: 一致シリーズを destination 配下へコピー。 */
export const seriesExtractCopy = (req: SeriesExtractRequest) =>
  httpSend<SeriesCopyResult>("/api/series-extract/copy", "POST", req);

/** 一致シリーズを ZIP で取得（standalone のローカルファイル）。 */
export const seriesExtractZip = async (req: SeriesExtractRequest): Promise<{ blob: Blob; filename: string }> => {
  const res = await fetch(`${apiBase()}/api/series-extract/zip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename="?([^"]+)"?/.exec(cd);
  return { blob, filename: m ? m[1] : "series-extract.zip" };
};

// ── DICOM Send（C-STORE SCU で外部 PACS/AE へ送信） ─────────────

/**
 * 設定済みリモート DICOM ノード（DICOM Send / Query-Retrieve 共通の接続先）。
 * application.yml の graphy.dicom.remote-aes ＋ Settings(H2) 由来。
 * tls=true でこのノードへの DIMSE 接続を TLS にする（鍵材料はグローバル TLS 設定を共用）。
 */
export interface RemoteAe {
  aeTitle: string;
  host: string;
  port: number;
  tls: boolean;
}

/** 設定済みリモート AE 一覧を取得する。 */
export const fetchRemoteAes = () => httpGet<RemoteAe[]>("/api/dicom/remote-aes");

/**
 * グローバル DIMSE TLS 設定（自局の鍵材料）。TLS を有効にした通信先へ接続する際に共通で使う。
 * usable は算出値（enabled かつ鍵/信頼ストアが実在するとき true）で、保存時は無視される。
 */
export interface TlsConfig {
  enabled: boolean;
  port: number;
  keyStore: string;
  keyStorePassword: string;
  keyStoreType: string;
  trustStore: string;
  trustStorePassword: string;
  trustStoreType: string;
  protocols: string[];
  cipherSuites: string[];
  needClientAuth: boolean;
  usable: boolean;
}

/** グローバル TLS 設定を取得する（保存が無ければ application.yml の既定）。 */
export const fetchTlsConfig = () => httpGet<TlsConfig>("/api/dicom/tls-config");

/** グローバル TLS 設定を保存する。SCU 送信は即時反映、SCP リスナーは再起動後に反映。 */
export const saveTlsConfig = (cfg: TlsConfig) => httpSend<TlsConfig>("/api/dicom/tls-config", "POST", cfg);

/** C-ECHO（疎通確認）の結果。 */
export interface EchoResult {
  success: boolean;
  status: number;
  elapsedMs: number;
  message: string;
}

/** リモート AE へ C-ECHO で疎通確認する。 */
export const echoDicom = (req: {
  host: string;
  port: number;
  calledAet: string;
  callingAet?: string;
  tls?: boolean;
}) =>
  httpSend<EchoResult>("/api/dicom/echo", "POST", {
    host: req.host,
    port: req.port,
    calledAet: req.calledAet,
    callingAet: req.callingAet ?? "",
    tls: req.tls ?? false,
  });

/** 送信対象（1 スタディと、その中で送る対象シリーズ。空ならスタディ全体）。 */
export interface SendSelection {
  studyUid: string;
  seriesUids: string[];
}

export interface SendRequest {
  selections: SendSelection[];
  host: string;
  port: number;
  calledAet: string;
  /** 自局 AE（空なら backend の既定 localAeTitle）。 */
  callingAet?: string;
  tls?: boolean;
}

/** 送信結果サマリ。 */
export interface SendResult {
  total: number;
  sent: number;
  failed: number;
  messages: string[];
}

/** 選択スタディ/シリーズをリモート AE へ C-STORE で送信する（standalone のローカル索引が前提）。 */
export const sendDicom = (req: SendRequest) =>
  httpSend<SendResult>("/api/dicom/send", "POST", {
    selections: req.selections,
    host: req.host,
    port: req.port,
    calledAet: req.calledAet,
    callingAet: req.callingAet ?? "",
    tls: req.tls ?? false,
  });

// ── Query/Retrieve（QR ウィンドウ） ────────────────────────────

/** リモート PACS の C-FIND（STUDY）結果行。年齢は studyDate−patientBirthDate から算出する。 */
export interface QrStudyRow {
  studyInstanceUid: string;
  patientId: string | null;
  patientName: string | null;
  patientBirthDate: string | null;
  patientSex: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  accessionNumber: string | null;
  modality: string | null;
  numberOfStudyRelatedSeries: number;
  numberOfStudyRelatedInstances: number;
}

/** リモート PACS の C-FIND（SERIES）結果行。 */
export interface QrSeriesRow {
  seriesInstanceUid: string;
  modality: string | null;
  seriesNumber: number | null;
  seriesDescription: string | null;
  protocolName: string | null;
  numberOfSeriesRelatedInstances: number;
}

/** リトリーブジョブの進捗。phase: retrieving | storing | done | error。 */
export interface QrRetrieveJob {
  expected: number;
  received: number;
  stored: number;
  done: boolean;
  success: boolean;
  phase: string;
  message: string;
}

interface QrDest {
  host: string;
  port: number;
  calledAet: string;
  /** このノードへの C-FIND/C-MOVE を TLS 接続にする。 */
  tls?: boolean;
}

/** QR: STUDY レベル C-FIND。matchKeys は C-FIND の検索キー（PatientID 等）。 */
export const qrFindStudies = (dest: QrDest, matchKeys: Record<string, string>) =>
  httpSend<QrStudyRow[]>("/api/dicom/qr/find-studies", "POST", { ...dest, matchKeys });

/** QR: SERIES レベル C-FIND（指定スタディ内のシリーズ）。 */
export const qrFindSeries = (dest: QrDest, studyUid: string, matchKeys: Record<string, string> = {}) =>
  httpSend<QrSeriesRow[]>("/api/dicom/qr/find-series", "POST", { ...dest, studyUid, matchKeys });

/** QR: リトリーブ開始。seriesUid 省略でスタディ全体。expected は進捗分母（C-FIND の件数）。 */
export const qrRetrieve = (
  dest: QrDest,
  studyUid: string,
  seriesUid: string | null,
  expected: number,
) =>
  httpSend<{ jobId: string }>("/api/dicom/qr/retrieve", "POST", {
    ...dest,
    studyUid,
    seriesUid: seriesUid ?? null,
    expected,
  });

/** QR: リトリーブ進捗を取得。 */
export const qrRetrieveStatus = (jobId: string) =>
  httpGet<QrRetrieveJob>(`/api/dicom/qr/retrieve/${encodeURIComponent(jobId)}`);

/** 保存済み件数の問い合わせ要素・結果。 */
export interface StoredQuery {
  studyUid: string;
  seriesUid?: string | null;
}
export interface StoredResult {
  studyUid: string;
  seriesUid: string | null;
  storedCount: number;
}

/** QR: 保存済み件数をバッチ問い合わせ（standalone=ローカル索引 / web=dcm4chee QIDO）。 */
export const qrStored = (queries: StoredQuery[]) =>
  httpSend<StoredResult[]>("/api/dicom/qr/stored", "POST", queries);

// --- Report（`fw/report-design.md`） ---

export type ReportType = "GENERAL" | "IMAGING_DIAGNOSTIC" | "TECHNOLOGIST" | "MEASUREMENT";
export type ReportStatus = "DRAFT" | "FINAL" | "ADDENDUM";
export type StaffRole = "PHYSICIAN" | "RADIOLOGIC_TECHNOLOGIST" | "MEDICAL_ASSISTANT" | "CLERICAL_WORKER" | "SCIENTIST";
export type ParticipationType = "AUTHOR" | "VERIFIER" | "ENTERER" | "REVIEWER";

export interface ReportSummary {
  id: string;
  patientId: string;
  studyInstanceUid: string;
  title: string | null;
  reportType: ReportType;
  status: ReportStatus;
  lockedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportParticipantDto {
  id: string;
  name: string;
  staffRole: StaffRole;
  participationType: ParticipationType;
  organization: string | null;
  participatedAt: string;
}

export interface ReportKeyImageDto {
  id: string;
  sopInstanceUid: string;
  seriesInstanceUid: string;
  frameNumber: number | null;
  label: string | null;
  annotation: string | null;
  sortOrder: number;
}

export interface ReportDetail extends ReportSummary {
  seriesInstanceUid: string | null;
  bodyMarkdown: string;
  clinicalHistory: string | null;
  referringPhysician: string | null;
  srSopInstanceUid: string | null;
  koSopInstanceUid: string | null;
  koSeriesInstanceUid: string | null;
  predecessorReportId: string | null;
  predecessorSrSopUid: string | null;
  lockedAt: string | null;
  participants: ReportParticipantDto[];
  keyImages: ReportKeyImageDto[];
}

export interface CreateReportRequest {
  patientId: string;
  studyInstanceUid: string;
  title?: string | null;
  reportType?: ReportType | null;
  clinicalHistory?: string | null;
  referringPhysician?: string | null;
  bodyMarkdown?: string | null;
}

export interface ReportParticipantInput {
  name: string;
  staffRole: StaffRole;
  participationType: ParticipationType;
  organization?: string | null;
}

export interface ReportKeyImageInput {
  sopInstanceUid: string;
  seriesInstanceUid: string;
  frameNumber?: number | null;
  label?: string | null;
  annotation?: string | null;
  sortOrder: number;
}

export interface UpdateReportRequest {
  title?: string | null;
  bodyMarkdown?: string | null;
  clinicalHistory?: string | null;
  referringPhysician?: string | null;
  participants?: ReportParticipantInput[] | null;
  keyImages?: ReportKeyImageInput[] | null;
  editedBy?: string | null;
}

export interface StudyReportCount {
  studyInstanceUid: string;
  reportState: "none" | "draft" | "report";
  reportCount: number;
  draftCount: number;
}

export const listReportsByStudy = (studyUid: string) =>
  httpGet<ReportSummary[]>(`/api/reports?studyUid=${encodeURIComponent(studyUid)}`);

export const getReport = (id: string) => httpGet<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`);

export const createReport = (req: CreateReportRequest) => httpSend<ReportDetail>("/api/reports", "POST", req);

export const updateReport = (id: string, req: UpdateReportRequest) =>
  httpSend<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`, "PUT", req);

export const deleteReport = (id: string) => httpSend<void>(`/api/reports/${encodeURIComponent(id)}`, "DELETE");

export const lockReport = (id: string, lockedBy: string) =>
  httpSend<ReportDetail>(`/api/reports/${encodeURIComponent(id)}/lock`, "POST", { lockedBy });

export const unlockReport = (id: string, lockedBy: string) =>
  httpSend<ReportDetail>(`/api/reports/${encodeURIComponent(id)}/unlock`, "POST", { lockedBy });

export const finalizeReport = (id: string) =>
  httpSend<ReportDetail>(`/api/reports/${encodeURIComponent(id)}/finalize`, "POST");

/** MainScreen 一覧の ●/○ 表示用（フェーズ R5 で StudyList に接続）。 */
export const fetchReportStudyCounts = (studyUids: string[]) =>
  httpGet<StudyReportCount[]>(`/api/reports/study-counts?studyUids=${encodeURIComponent(studyUids.join(","))}`);

// ── GLAM 解析（ROI 全体・記述子そのもの） ───────────────────────

/** GLAM 解析の要求（backend: POST /api/radiomics/glam/analyze）。 */
export interface GlamAnalysisRequest {
  studyInstanceUid: string;
  sourceSeriesUid: string;
  /** ROI マスクシリーズ（**必須**。全面では意味のある動径分布にならない）。 */
  maskSeriesUid: string;
  maskChannel: number;
  channel: number;
  timePoint: number;
  /** 動径分布を見る最大距離（ボクセル, 未指定で 30）。 */
  maxRadius?: number | null;
  settings: Record<string, string>;
}

/**
 * GLAM 解析の結果＝記述子そのもの。
 *
 * 特徴量 150 個は行列を要約した「答え」だが、解釈に効くのはその手前にある動径分布関数と
 * 親和性行列（原著論文の図が見せているのはこちら）。
 */
export interface GlamAnalysis {
  featureCount: number;
  nBins: number;
  maxRadius: number;
  roiVoxelCount: number;
  /** ビンごとのボクセル数。**稀なビンほど g(r) は跳ねる**ので曲線を読む前に見る。 */
  binOccupancy: number[];
  /** r の値（1..maxRadius）。 */
  radii: number[];
  /** 自己親和性 g(α,α,r)。`[α][r]`。**1.0 が「偶然と区別がつかない」水準**。 */
  selfAffinity: number[][];
  /** 同じ並びのランダム参照状態。 */
  selfAffinityRandom: number[][];
  /**
   * 異なる濃度値どうしの親和性 g(α,β,r)。`[α][β][r]`（α=β の対角も含む）。
   * nBins² × maxRadius が大きすぎる設定では `null`（理由は `crossAffinityOmitted`）。
   */
  crossAffinity: number[][][] | null;
  /** `crossAffinity` を返さなかった理由（返した場合は null）。 */
  crossAffinityOmitted: string | null;
  /** 親和性行列 19 種。キーは GLAMMatrixType 名、値は nBins×nBins。 */
  matrices: Record<string, number[][]>;
  /** 自己ペアだけで定義される行列（非対角に意味が無い）。 */
  diagonalOnly: string[];
  /** 特徴量 150 個（GLAMFeatureType 名 → 値）。定義されない組み合わせは null。 */
  features: Record<string, number | null>;
  /** **計算に使った**ボクセル間隔 (x,y,z) mm。 */
  voxelSpacing: number[];
  isotropic: boolean;
  /** リサンプリングした場合の**元の**ボクセル間隔 (x,y,z) mm。していなければ null。 */
  resampledFrom: number[] | null;
  settings: Record<string, string>;
}

/** 保存された解析の一覧行（JSON 本体は含まない）。 */
export interface GlamSavedSummary {
  id: string;
  label: string;
  sourceSeriesUid: string;
  maskSeriesUid: string | null;
  nBins: number;
  maxRadius: number;
  roiVoxelCount: number;
  savedAt: string;
}

/** ROI 全体で GLAM を計算する（保存はしない）。 */
export const analyzeGlam = (req: GlamAnalysisRequest) =>
  httpSend<GlamAnalysis>("/api/radiomics/glam/analyze", "POST", req);

/** 保存された解析の一覧（study 単位・新しい順）。 */
export const listGlamAnalyses = (studyInstanceUid: string) =>
  httpGet<GlamSavedSummary[]>(
    `/api/radiomics/glam/saved?studyInstanceUid=${encodeURIComponent(studyInstanceUid)}`,
  );

/** 保存された解析を読み出す。 */
export const loadGlamAnalysis = (id: string) =>
  httpGet<GlamAnalysis>(`/api/radiomics/glam/saved/${encodeURIComponent(id)}`);

/** 解析結果を保存する（利用者が保存を選んだときだけ）。 */
export const saveGlamAnalysis = (body: {
  studyInstanceUid: string;
  sourceSeriesUid: string;
  maskSeriesUid: string | null;
  label: string;
  analysis: GlamAnalysis;
}) => httpSend<GlamSavedSummary>("/api/radiomics/glam/saved", "POST", body);

/** 保存された解析を消す。 */
export const deleteGlamAnalysis = (id: string) =>
  httpSend<void>(`/api/radiomics/glam/saved/${encodeURIComponent(id)}`, "DELETE");
