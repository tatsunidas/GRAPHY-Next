/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

/**
 * {@code POST /api/reports} のリクエスト本文。新規レポートは常に {@code status=DRAFT} で作成される。
 * 初期本文（見出しテンプレート）は frontend が組み立てて {@code bodyMarkdown} に渡す
 * （`fw/report-design.md` §5。i18n はフロント側の関心事のため backend では固定文言を持たない）。
 */
public record CreateReportRequest(
        String patientId,
        String studyInstanceUid,
        String title,
        ReportType reportType,
        String clinicalHistory,
        String referringPhysician,
        String bodyMarkdown) {
}
