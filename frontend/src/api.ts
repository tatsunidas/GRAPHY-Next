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

/** 単一インスタンス（SOP）の属性ダンプを取得する（standalone のローカル索引のみ）。 */
export const fetchInstanceTags = (sopUid: string) =>
  httpGet<TagDumpRow[]>(`/api/instances/${encodeURIComponent(sopUid)}/tags`);

/** Encapsulated PDF Storage の SOP Class UID（ピクセル無し＝画像ビューア非対応）。 */
export const ENCAPSULATED_PDF_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.104.1";

/** Video Photographic Image Storage の SOP Class UID（encapsulated 動画＝2D 画像ビューア非対応）。 */
export const VIDEO_PHOTOGRAPHIC_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.77.1.4.1";

/** Encapsulated Document（PDF 等）の中身を配信する URL（inline / download）。 */
export const instanceDocumentUrl = (sopUid: string, download = false) =>
  `${apiBase()}/api/instances/${encodeURIComponent(sopUid)}/document${download ? "?download=true" : ""}`;

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

// ── TagExtractor（タグ一括抽出） ───────────────────────────────

export interface TagExtractRequest {
  /** 抽出対象スタディ（必須）。 */
  studyUid: string;
  /** シリーズに絞る場合に指定。未指定ならスタディ全体。 */
  seriesUid?: string;
  /** 抽出するタグ番号（8 桁 hex, 例 "00100010"）。 */
  tags: string[];
  format: "csv" | "json";
}

/**
 * タグ抽出を実行し、ダウンロード用の Blob とサーバ提案ファイル名を返す。
 * レスポンスはファイル本体（JSON ラッパではない）なので http ラッパは使わず直接 fetch する。
 */
export const extractTags = async (
  req: TagExtractRequest,
): Promise<{ blob: Blob; filename: string }> => {
  const res = await fetch(`${apiBase()}/api/extract/tags`, {
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
  const filename = m ? m[1] : `tags.${req.format}`;
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

// ── DICOM Send（C-STORE SCU で外部 PACS/AE へ送信） ─────────────

/** 設定済みリモート AE（送信先候補）。application.yml の graphy.dicom.remote-aes 由来。 */
export interface RemoteAe {
  aeTitle: string;
  host: string;
  port: number;
}

/** 設定済みリモート AE 一覧を取得する。 */
export const fetchRemoteAes = () => httpGet<RemoteAe[]>("/api/dicom/remote-aes");

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
