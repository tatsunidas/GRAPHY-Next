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
import { httpGet, httpSend } from "../http";

export interface RoiDocumentDto {
  patientKey: string;
  /** ROI 配列の JSON（未保存なら null）。 */
  json: string | null;
  roiCount: number;
  updatedAt: string | null;
  /** 楽観ロックの版（未保存なら null）。 */
  version: number | null;
}

const path = (patientKey: string): string => `/api/rois/${encodeURIComponent(patientKey)}`;

export const fetchRoiDocument = (patientKey: string): Promise<RoiDocumentDto> =>
  httpGet<RoiDocumentDto>(path(patientKey));

export const saveRoiDocument = (
  patientKey: string,
  json: string,
  roiCount: number,
  version: number | null,
): Promise<RoiDocumentDto> =>
  httpSend<RoiDocumentDto>(path(patientKey), "PUT", { json, roiCount, version });

export const deleteRoiDocument = (patientKey: string): Promise<void> =>
  httpSend<void>(path(patientKey), "DELETE");
