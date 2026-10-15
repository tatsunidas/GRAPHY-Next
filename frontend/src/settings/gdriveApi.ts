/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";
import type { GdriveLocalizeProgress, GdriveRestoreProgress, GdriveSyncStatus } from "./gdriveView";

export const fetchGdriveStatus = () => httpGet<GdriveSyncStatus>("/api/gdrive/status");
export const gdriveSyncNow = () => httpSend<{ ok: boolean }>("/api/gdrive/sync", "POST");
export const gdriveTakeOver = () => httpSend<{ ok: boolean }>("/api/gdrive/takeover", "POST");
export const fetchGdriveRestore = () => httpGet<GdriveRestoreProgress>("/api/gdrive/restore");
/** すべてローカルに保存（モード A）。空き容量が足りなければ HttpError(400, "not-enough-space")。 */
export const startGdriveLocalize = () => httpSend<{ ok: boolean }>("/api/gdrive/localize", "POST");
export const fetchGdriveLocalize = () => httpGet<GdriveLocalizeProgress>("/api/gdrive/localize");
/** 取り消し。すでに取った分は手元に残り、追い出しの停止も解く。 */
export const cancelGdriveLocalize = () => httpSend<{ ok: boolean }>("/api/gdrive/localize", "DELETE");
