/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { apiBase } from "../apiBase";

export type ViewerMode = "standalone" | "web";

/**
 * SOP インスタンスから Cornerstone3D の imageId を組み立てる。
 * - standalone: backend の Part-10 配信を wadouri で読む（`/api/instances/{sop}/file`）。
 * - web: backend(BFF) が PACS の WADO-RS から取得した Part-10 を wadouri で読む
 *   （`/api/studies/{study}/series/{series}/instances/{sop}/file`）。ピクセル経路も BFF 一本
 *   （fw/dicom-data-layer.md §5）＝同一オリジンで CORS 不要。WADO-RS は study/series/sop を要するため
 *   web は study/series が必須。
 */
export function imageIdForInstance(
  mode: ViewerMode,
  sopUid: string,
  studyUid?: string,
  seriesUid?: string,
): string {
  if (mode === "standalone") {
    return `wadouri:${apiBase()}/api/instances/${encodeURIComponent(sopUid)}/file`;
  }
  // web
  if (!studyUid || !seriesUid) {
    throw new Error("web mode の imageId には studyUid/seriesUid が必要です");
  }
  return `wadouri:${apiBase()}/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(
    seriesUid,
  )}/instances/${encodeURIComponent(sopUid)}/file`;
}

/**
 * マルチフレーム（Siemens モザイクの 1 タイル、または DICOM SEG/Enhanced の 1 フレーム）の imageId。
 * backend が {@code .../frames/{frame}/file} でフレームを単一フレーム DICOM として返す。
 * - standalone: {@code /api/instances/{sop}/frames/{frame}/file}。
 * - web: {@code /api/studies/{study}/series/{series}/instances/{sop}/frames/{frame}/file}
 *   （{@link WebDicomDataService#retrieveInstance} で取得した Part-10 からフレーム抽出、BFF 一本）。
 * <p>モザイクは standalone のみ（web の {@link SeriesLayoutAssembler} はモザイクをデモザイクしない）。
 * DICOM SEG は両モードとも frame>=0 を返す。
 */
export function imageIdForFrame(
  mode: ViewerMode,
  sopUid: string,
  frame: number,
  studyUid?: string,
  seriesUid?: string,
): string {
  if (frame < 0) {
    return imageIdForInstance(mode, sopUid, studyUid, seriesUid);
  }
  if (mode === "standalone") {
    return `wadouri:${apiBase()}/api/instances/${encodeURIComponent(sopUid)}/frames/${frame}/file`;
  }
  // web
  if (!studyUid || !seriesUid) {
    throw new Error("web mode の imageId には studyUid/seriesUid が必要です");
  }
  return `wadouri:${apiBase()}/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(
    seriesUid,
  )}/instances/${encodeURIComponent(sopUid)}/frames/${frame}/file`;
}

/**
 * XA/XRF シネの 1 フレームの imageId（**ローダ内フレーム指定**）。
 *
 * <p>{@link imageIdForFrame}（backend がフレームを単一フレーム DICOM に切り出す `/frames/{n}/file`）とは
 * **別物**。XA では後者を使ってはいけない — 1 ラン数十〜数百フレームに対して**フレーム数ぶん HTTP が飛び**、
 * サーバ側で毎回 Part-10 を再構成することになり 30fps に届かない。
 * こちらは **Part-10 を 1 回だけ取得**し、dicom-image-loader がファイル内のフレームを切り出す
 * （dataSet は URL 単位でキャッシュされ、フレーム間で共有される）。
 *
 * <p>🚨 **フレーム番号は 1 origin**（DICOM のフレーム番号と同じ）。ここが唯一の +1 地点。
 * 呼び出し側は 0 origin の t をそのまま渡すこと。
 *
 * <p>🚨 **`&frame=` 区切りにすること**。loader の `parseImageId` は `frame=` の**直前 1 文字を
 * 無条件に落として** URL を得る（`url.substring(0, frameIndex - 1)`）ので、区切り文字は 1 文字必要。
 * `&` はライブラリ自身の慣行（`generateMultiframeWADOURIs`）に合わせてある。URL 自体は
 * クエリを持たないので、剥がされた後は `.../file` になる。
 *
 * @param frame 0 origin のフレーム番号（内部で +1 する）
 */
export function imageIdForXaFrame(
  mode: ViewerMode,
  sopUid: string,
  frame: number,
  studyUid?: string,
  seriesUid?: string,
): string {
  const base = imageIdForInstance(mode, sopUid, studyUid, seriesUid);
  return `${base}&frame=${Math.max(0, Math.floor(frame)) + 1}`;
}

/**
 * XA フレーム imageId から、元インスタンスの取得 URL（＝loader の dataSet キャッシュキー）を取り出す。
 * プリウォーム（{@code viewer/xaCine.ts}）で使う。`wadouri:` スキームは剥がす。
 */
export function xaSourceUrlOf(imageId: string): string {
  const colon = imageId.indexOf(":");
  const withoutScheme = colon >= 0 ? imageId.slice(colon + 1) : imageId;
  const at = withoutScheme.indexOf("frame=");
  return at > 0 ? withoutScheme.slice(0, at - 1) : withoutScheme;
}

/** セル（モザイクなら frame>=0）から imageId を組み立てる。web は study/series が必須。 */
export function imageIdForCell(
  mode: ViewerMode,
  sopUid: string,
  frame: number | undefined,
  studyUid?: string,
  seriesUid?: string,
): string {
  return frame !== undefined && frame >= 0
    ? imageIdForFrame(mode, sopUid, frame, studyUid, seriesUid)
    : imageIdForInstance(mode, sopUid, studyUid, seriesUid);
}

/**
 * 範囲外パディング用ブランク画像の imageId。backend がシリーズ幾何を引き継いだ
 * 単一フレーム DICOM（最小値で塗りつぶし・Image 属性/UID 付き）を生成して返す。
 * ipp（[x,y,z]）で穴の物理位置を指定すると、その ImagePositionPatient を持つ。
 */
export function imageIdForBlank(
  studyUid: string,
  seriesUid: string,
  ipp?: [number, number, number],
): string {
  const base = `${apiBase()}/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/blank/file`;
  const q = ipp ? `?ipp=${ipp[0]},${ipp[1]},${ipp[2]}` : "";
  return `wadouri:${base}${q}`;
}
