/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";
import type { GdriveRestoreProgress, GdriveSyncStatus } from "./gdriveView";

export const fetchGdriveStatus = () => httpGet<GdriveSyncStatus>("/api/gdrive/status");
export const gdriveSyncNow = () => httpSend<{ ok: boolean }>("/api/gdrive/sync", "POST");
export const gdriveTakeOver = () => httpSend<{ ok: boolean }>("/api/gdrive/takeover", "POST");
export const fetchGdriveRestore = () => httpGet<GdriveRestoreProgress>("/api/gdrive/restore");
