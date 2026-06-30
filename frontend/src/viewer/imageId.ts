/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { apiBase } from "../apiBase";

export type ViewerMode = "standalone" | "web";

/**
 * SOP インスタンスから Cornerstone3D の imageId を組み立てる。
 * - standalone: backend の Part-10 配信を wadouri で読む（`/api/instances/{sop}/file`）。
 * - web: WADO-RS（wadors）経由。次フェーズで実装するため、ここでは呼び出さない。
 */
export function imageIdForInstance(mode: ViewerMode, sopUid: string): string {
  if (mode === "standalone") {
    return `wadouri:${apiBase()}/api/instances/${encodeURIComponent(sopUid)}/file`;
  }
  throw new Error("web mode の 2D ビューアは次フェーズで実装します");
}

/**
 * Siemens モザイクの 1 タイル（デモザイク後の 1 スライス）の imageId。
 * backend が {@code /instances/{sop}/frames/{frame}/file} でタイルを単一フレーム DICOM として返す。
 */
export function imageIdForFrame(mode: ViewerMode, sopUid: string, frame: number): string {
  if (frame < 0) {
    return imageIdForInstance(mode, sopUid);
  }
  if (mode === "standalone") {
    return `wadouri:${apiBase()}/api/instances/${encodeURIComponent(sopUid)}/frames/${frame}/file`;
  }
  throw new Error("web mode の 2D ビューアは次フェーズで実装します");
}

/** セル（モザイクなら frame>=0）から imageId を組み立てる。 */
export function imageIdForCell(mode: ViewerMode, sopUid: string, frame: number | undefined): string {
  return frame !== undefined && frame >= 0
    ? imageIdForFrame(mode, sopUid, frame)
    : imageIdForInstance(mode, sopUid);
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
