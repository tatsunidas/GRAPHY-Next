/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * IHE IID（Invoke Image Display）起動パラメータの解釈。
 *
 * <p>dcm4chee UI2 等の外部ビューアリンクは、GRAPHY(web) の URL を
 * {@code ?requestType=STUDY&studyUID=1.2.3(&seriesUID=...)} の形で開く。ここで URL クエリを解釈し、
 * App が web モードのメインウィンドウ起動時に当該 study を 2D ビューアで直接開く導線に使う
 * （fw/ui-architecture.md §IID・fw/dicom-data-layer.md §5）。
 *
 * <p>キー名の揺れに寛容にする: `studyUID`（IHE 標準）/ `studyInstanceUID` / `StudyInstanceUID` を受ける。
 */
export interface IidLaunch {
  studyUID: string;
  seriesUID?: string;
  /** requestType（STUDY / SERIES / IMAGE 等。無指定は STUDY 相当）。 */
  requestType?: string;
}

/** 大小・別名を吸収してクエリ値を引く。 */
function pick(params: URLSearchParams, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = params.get(k);
    if (v != null && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/**
 * 現在の URL（`window.location.search`）から IID 起動パラメータを取り出す。studyUID が無ければ null。
 * `location` を差し替え可能にしてテストしやすくする。
 */
export function parseIidLaunch(search: string): IidLaunch | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search || "");
  } catch {
    return null;
  }
  const studyUID = pick(params, "studyUID", "studyInstanceUID", "StudyInstanceUID");
  if (!studyUID) return null;
  return {
    studyUID,
    seriesUID: pick(params, "seriesUID", "seriesInstanceUID", "SeriesInstanceUID"),
    requestType: pick(params, "requestType"),
  };
}
