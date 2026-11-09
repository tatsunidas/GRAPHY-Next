/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";
import type { PrefetchPreview, PrefetchStatus } from "./prefetchView";

/** web モードでは 404（この機能は standalone のみ）。 */
export const fetchPrefetchStatus = () => httpGet<PrefetchStatus>("/api/prefetch/status");

/** 手動実行を始める（すぐ返る。結果は状態の runs で見る。走行中は 409）。 */
export const runPrefetchNow = () => httpSend<void>("/api/prefetch/run", "POST");

/** 予約一覧だけ取って、日（YYYYMMDD）ごとの患者数を返す。取得はしない。取れなければ error に理由のコード。 */
export const previewPrefetchSchedule = () => httpSend<PrefetchPreview>("/api/prefetch/preview-schedule", "POST");
