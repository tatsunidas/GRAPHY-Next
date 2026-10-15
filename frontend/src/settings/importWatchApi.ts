/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet } from "../http";
import type { ImportWatchStatus } from "./importWatchView";

/** web モードでは 404（この機能は standalone のみ）。 */
export const fetchImportWatchStatus = () => httpGet<ImportWatchStatus>("/api/import/watch/status");
