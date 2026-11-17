/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";
import type { EmrCheck, EmrStatus } from "./emrView";

/** web モードでは 404（この機能は standalone のみ）。 */
export const fetchEmrStatus = () => httpGet<EmrStatus>("/api/emr/status");

/** 保存した設定で、いまファイルから ID が読めるかを確かめる（ID は全文でなく、先頭と末尾だけ返る）。 */
export const checkEmrFile = () => httpSend<EmrCheck>("/api/emr/check", "POST");

/** いまの患者の過去検査を、もう一度取りに行く（［開く］を押したとき）。 */
export const refetchEmrPatient = () => httpSend<EmrStatus["fetch"]>("/api/emr/prefetch", "POST");
