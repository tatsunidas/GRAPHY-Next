/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン保存領域の REST クライアント（`/api/plugin-store/{pluginId}/{patientKey}`。host API の H8）。
 *
 * <p>中身のスキーマは**プラグイン側が正本**。ここは搬送と**版（version）の保持**だけを持つ。
 * 版は「読んだときの値を保存時に返送する」規約で、別ウィンドウ・別端末が先に保存していたら
 * backend が 409 を返す。数か月分の評価記録を黙って消さないための最後の砦なので、
 * **409 を握り潰さない**（呼び出し側が読み直して統合してから再保存する）。
 */
import { httpGet, httpSend } from "../http";

export interface PluginDocumentDto {
  pluginId: string;
  patientKey: string;
  /** プラグインが保存した JSON（未保存なら null）。 */
  json: string | null;
  updatedAt: string | null;
  /** 楽観ロックの版（未保存なら null）。 */
  version: number | null;
}

// 🔴 **キーはクエリで渡す**（パスに入れない）。PatientID には `/` が普通に入り
//    （実データ `D97258/11053`）、`%2F` にしても **Tomcat が経路の段で 400 を返す**。
//    Spring まで届かないので CORS ヘッダも付かず、ブラウザには「CORS エラー」に見える。
//    結果は「**その患者だけ保存されない**」で、画面には何も出ない（実測・2026-08-26）。
const path = (pluginId: string, patientKey: string): string =>
  `/api/plugin-store/${encodeURIComponent(pluginId)}?patientKey=${encodeURIComponent(patientKey)}`;

export const fetchPluginDocument = (pluginId: string, patientKey: string): Promise<PluginDocumentDto> =>
  httpGet<PluginDocumentDto>(path(pluginId, patientKey));

export const savePluginDocument = (
  pluginId: string,
  patientKey: string,
  json: string,
  version: number | null,
): Promise<PluginDocumentDto> =>
  httpSend<PluginDocumentDto>(path(pluginId, patientKey), "PUT", { json, version });

export const deletePluginDocument = (pluginId: string, patientKey: string): Promise<void> =>
  httpSend<void>(path(pluginId, patientKey), "DELETE");
