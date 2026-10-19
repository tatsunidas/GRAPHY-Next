/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";
import type { ImportWatchStatus } from "./importWatchView";

/** web モードでは 404（この機能は standalone のみ）。 */
export const fetchImportWatchStatus = () => httpGet<ImportWatchStatus>("/api/import/watch/status");

/** 間隔を待たずに 1 回走査する。走査が終わってから、そのときの状態が返る。 */
export const scanImportWatchNow = () => httpSend<ImportWatchStatus>("/api/import/watch/scan", "POST");
