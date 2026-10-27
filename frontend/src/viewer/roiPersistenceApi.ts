/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 永続化の REST クライアント（`/api/rois/{patientKey}`）。
 *
 * <p>スキーマは {@link ./roiPersistence} が正本。ここは搬送と**版（version）の保持**だけを持つ。
 * 版は「読んだときの値を保存時に返送する」規約で、別ウィンドウが先に保存していたら backend が
 * 409 を返す。RECIST のような長期の計測を黙って消さないための最後の砦なので、
 * **409 を握り潰さない**（呼び出し側が読み直して再保存する）。
 */
import { apiBase } from "../apiBase";
import { extractErrorMessage, HttpError, httpGet, httpSend, KEEPALIVE_MAX_BYTES } from "../http";

export interface RoiDocumentDto {
  patientKey: string;
  /** ROI 配列の JSON（未保存なら null）。 */
  json: string | null;
  roiCount: number;
  updatedAt: string | null;
  /** 楽観ロックの版（未保存なら null）。 */
  version: number | null;
}

// 🔴 **キーはクエリで渡す**（パスに入れない）。PatientID には `/` が普通に入り
//    （実データ `D97258/11053`）、`%2F` にしても **Tomcat が経路の段で 400 を返す**。
//    Spring まで届かないので CORS ヘッダも付かず、ブラウザには「CORS エラー」に見える。
//    結果は「**その患者だけ保存されない**」で、画面には何も出ない（実測・2026-08-26）。
const path = (patientKey: string): string => `/api/rois?patientKey=${encodeURIComponent(patientKey)}`;

export const fetchRoiDocument = (patientKey: string): Promise<RoiDocumentDto> =>
  httpGet<RoiDocumentDto>(path(patientKey));

export async function saveRoiDocument(
  patientKey: string,
  json: string,
  roiCount: number,
  version: number | null,
  keepalive = false,
): Promise<RoiDocumentDto> {
  const body = JSON.stringify({ json, roiCount, version });
  // 閉じる・再読み込みの直前に送るとき用。`keepalive` は本体が小さいときだけ付ける（超えると要求ごと失敗する）。
  if (keepalive && new Blob([body]).size <= KEEPALIVE_MAX_BYTES) {
    const res = await fetch(`${apiBase()}${path(patientKey)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
    if (!res.ok) throw new HttpError(await extractErrorMessage(res), res.status);
    return (await res.json()) as RoiDocumentDto;
  }
  return httpSend<RoiDocumentDto>(path(patientKey), "PUT", { json, roiCount, version });
}

export const deleteRoiDocument = (patientKey: string): Promise<void> =>
  httpSend<void>(path(patientKey), "DELETE");
