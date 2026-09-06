/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 「このシリーズを 2D 画像ビューアで開けるか」の判定。
 *
 * <p>DICOM の SOP クラスには**ピクセルを持たないもの**がある（RT Structure Set、構造化レポート、
 * 表示状態、レジストレーション、Encapsulated PDF …）。これらをシリーズ一覧から開くと
 * Cornerstone の `createImage` が `The pixel data is missing` で reject し、**未処理の Promise
 * 例外がコンソールに出るだけで、ユーザーには何も起きていないように見える**（実機で発生）。
 * 開く前にここで弾き、理由を提示する。
 *
 * <p>判定は **SOP クラス優先、無ければ Modality** で行う。standalone は代表インスタンスの
 * SOP クラスを索引から返せるが、web（QIDO）はシリーズ階層に SOP クラスが無いため Modality しか
 * 手に入らないことがある。Modality だけでは足りない例があるので両方見る:
 * **Surface Segmentation（1.2.840.10008.5.1.4.1.1.66.5）は Modality が SEG** だが面データで
 * ピクセルを持たない（一方 DICOM SEG=66.4 は labelmap を持つので開ける）。
 *
 * <p>未知のものは**開ける扱い**（fail-open）にする。画像なのに開けないほうが害が大きく、
 * 万一ピクセルが無ければ読み込み側がエラーを表示する（二段構え）。
 */

/** 画像として開けない SOP クラス → 人向けの種別名。 */
const NON_IMAGE_SOP_CLASSES: Readonly<Record<string, string>> = {
  "1.2.840.10008.5.1.4.1.1.481.3": "RT Structure Set",
  "1.2.840.10008.5.1.4.1.1.481.5": "RT Plan",
  "1.2.840.10008.5.1.4.1.1.481.6": "RT Brachy Treatment Record",
  "1.2.840.10008.5.1.4.1.1.481.7": "RT Treatment Summary Record",
  "1.2.840.10008.5.1.4.1.1.66": "Raw Data",
  "1.2.840.10008.5.1.4.1.1.66.1": "Spatial Registration",
  "1.2.840.10008.5.1.4.1.1.66.2": "Spatial Fiducials",
  "1.2.840.10008.5.1.4.1.1.66.3": "Deformable Spatial Registration",
  // 66.4（Segmentation）は labelmap のピクセルを持つので**開ける**。
  "1.2.840.10008.5.1.4.1.1.66.5": "Surface Segmentation",
  "1.2.840.10008.5.1.4.1.1.66.6": "Tractography Results",
  "1.2.840.10008.5.1.4.1.1.11.1": "Grayscale Softcopy Presentation State",
  "1.2.840.10008.5.1.4.1.1.11.2": "Color Softcopy Presentation State",
  "1.2.840.10008.5.1.4.1.1.11.3": "Pseudo-Color Softcopy Presentation State",
  "1.2.840.10008.5.1.4.1.1.11.4": "Blending Softcopy Presentation State",
  // XA/XRF GSPS。画像としては開けないが、**参照画像に適用できる**（§14.1 / A10）。
  // シリーズビューアの「表示状態を適用」から当てる。
  "1.2.840.10008.5.1.4.1.1.11.5": "XA/XRF Grayscale Softcopy Presentation State",
  "1.2.840.10008.5.1.4.1.1.88.11": "Basic Text SR",
  "1.2.840.10008.5.1.4.1.1.88.22": "Enhanced SR",
  "1.2.840.10008.5.1.4.1.1.88.33": "Comprehensive SR",
  "1.2.840.10008.5.1.4.1.1.88.34": "Comprehensive 3D SR",
  "1.2.840.10008.5.1.4.1.1.88.59": "Key Object Selection",
  "1.2.840.10008.5.1.4.1.1.88.65": "Chest CAD SR",
  "1.2.840.10008.5.1.4.1.1.88.67": "X-Ray Radiation Dose SR",
  "1.2.840.10008.5.1.4.1.1.104.1": "Encapsulated PDF",
  "1.2.840.10008.5.1.4.1.1.104.2": "Encapsulated CDA",
  "1.2.840.10008.5.1.4.1.1.104.3": "Encapsulated STL",
  "1.2.840.10008.5.1.4.1.1.9.1.1": "12-lead ECG Waveform",
  "1.2.840.10008.5.1.4.1.1.9.1.2": "General ECG Waveform",
  "1.2.840.10008.5.1.4.1.1.9.4.1": "Basic Voice Audio Waveform",
};

/** SOP クラスが取れないとき用（web の QIDO 等）。Modality は defined term なので概ね信頼できる。 */
const NON_IMAGE_MODALITIES: Readonly<Record<string, string>> = {
  RTSTRUCT: "RT Structure Set",
  RTPLAN: "RT Plan",
  RTRECORD: "RT Treatment Record",
  SR: "Structured Report",
  KO: "Key Object Selection",
  PR: "Presentation State",
  REG: "Registration",
  FID: "Fiducials",
  DOC: "Encapsulated Document",
  PLAN: "Plan",
  ECG: "ECG Waveform",
  AU: "Audio",
  HD: "Hemodynamic Waveform",
  EPS: "Cardiac Electrophysiology Waveform",
  SMR: "Structured Measurement Report",
};

export interface SeriesRenderability {
  /** 2D 画像ビューアで開けるか。 */
  renderable: boolean;
  /** 開けない場合の種別名（人に見せる。例 "RT Structure Set"）。開ける場合は null。 */
  kind: string | null;
  /** 判定の根拠（デバッグ・説明用）。 */
  by: "sopClass" | "modality" | null;
}

const RENDERABLE: SeriesRenderability = { renderable: true, kind: null, by: null };

/**
 * シリーズが 2D 画像ビューアで開けるかを判定する。純関数。
 *
 * @param series `sopClassUid` は standalone では代表インスタンスの値、web では取れないことがある
 */
export function classifySeriesRenderability(series: {
  sopClassUid?: string | null;
  modality?: string | null;
}): SeriesRenderability {
  const sop = series.sopClassUid?.trim();
  if (sop) {
    const kind = NON_IMAGE_SOP_CLASSES[sop];
    // SOP クラスが分かっているなら、それが結論（Modality は見ない）。
    // 例: Modality=SEG でも 66.5（Surface）は開けず、66.4（labelmap）は開ける。
    return kind ? { renderable: false, kind, by: "sopClass" } : RENDERABLE;
  }
  const modality = series.modality?.trim().toUpperCase();
  if (modality) {
    const kind = NON_IMAGE_MODALITIES[modality];
    if (kind) return { renderable: false, kind, by: "modality" };
  }
  return RENDERABLE;
}

/** 開けないシリーズか（真偽だけ要るとき）。 */
export function isNonImageSeries(series: {
  sopClassUid?: string | null;
  modality?: string | null;
}): boolean {
  return !classifySeriesRenderability(series).renderable;
}

/** Video Photographic Image Storage の SOP Class UID（encapsulated 動画）。 */
export const VIDEO_PHOTOGRAPHIC_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.77.1.4.1";

/**
 * encapsulated 動画系 SOP Class（Endoscopic / Microscopic / Photographic）。
 *
 * <p>これらは MP4 等を丸ごと DICOM に包んだもので**画素データを持たない**。
 * ⚠ **XA / US のシネは含まれない。** あれは通常の画素データが時間方向に並んだマルチフレームで、
 * SOP クラスも別。「DICOM の動画」には構造の違う 2 種類がある、という区別がここの要点。
 */
export const VIDEO_SOP_CLASSES: ReadonlySet<string> = new Set([
  "1.2.840.10008.5.1.4.1.1.77.1.1.1", // Video Endoscopic Image Storage
  "1.2.840.10008.5.1.4.1.1.77.1.2.1", // Video Microscopic Image Storage
  VIDEO_PHOTOGRAPHIC_SOP_CLASS, // Video Photographic Image Storage
]);

/** SOP Class UID が encapsulated 動画かどうか。 */
export const isVideoSopClass = (sopClassUid: string | null | undefined): boolean =>
  !!sopClassUid && VIDEO_SOP_CLASSES.has(sopClassUid);

/**
 * シリーズを 2D ビューアで「どう出すか」。`classifySeriesRenderability` が
 * 「開けるか」を見るのに対し、こちらは**どの表示器に振り分けるか**を決める。
 *
 * - `image` … 従来どおり Viewer2D（Cornerstone StackViewport）
 * - `video` … VideoViewer（`/rendered` の mp4 を VideoViewport / `<video>` で再生）
 * - `videoUnavailable` … 動画だが、この動作モードでは再生できない
 *
 * <p>encapsulated 動画は画素を持たないため、wadouri を通す Viewer2D では
 * `The pixel data is missing` になる。再生器へ振り分ける必要がある。
 *
 * <p>判定は StudyList と同じく**先頭インスタンスの SOP クラス**で行う。シリーズ内で SOP が
 * 混ざることは通常なく、混在時に一部だけ再生器へ送ると画面が割れるため代表で決める。
 *
 * <p>web(BFF) モードでは `/rendered` が索引のローカルファイルを前提にしていて使えないため
 * `videoUnavailable` を返す（`fw/video-viewer-design.md` §8）。
 */
export type SeriesDisplay = "image" | "video" | "videoUnavailable";

export function classifySeriesDisplay(
  instances: readonly { sopClassUid?: string | null }[],
  mode: "standalone" | "web",
): SeriesDisplay {
  if (instances.length === 0) return "image";
  if (!isVideoSopClass(instances[0].sopClassUid)) return "image";
  return mode === "standalone" ? "video" : "videoUnavailable";
}
