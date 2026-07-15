/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { ReportType } from "../api";
import { fetchSettings } from "../settings/settingsApi";

const REPORT_TYPES: ReportType[] = ["GENERAL", "IMAGING_DIAGNOSTIC", "TECHNOLOGIST", "MEASUREMENT"];

/** 環境設定「レポート」＞「デフォルトの種別」を読む。未設定/不正値は GENERAL。 */
export async function resolveDefaultReportType(): Promise<ReportType> {
  try {
    const m = await fetchSettings();
    const v = m["report.defaultType"];
    return (REPORT_TYPES as string[]).includes(v ?? "") ? (v as ReportType) : "GENERAL";
  } catch {
    return "GENERAL";
  }
}
