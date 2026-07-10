/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import java.time.Instant;

/**
 * レポート一覧表示用の要約（本文・参加者・キー画像は含まない）。
 * {@code GET /api/reports?studyUid=} / {@code ?patientId=} の応答。
 */
public record ReportSummaryDto(
        String id,
        String patientId,
        String studyInstanceUid,
        String title,
        ReportType reportType,
        ReportStatus status,
        String lockedBy,
        Instant createdAt,
        Instant updatedAt) {
}
