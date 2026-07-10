/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import java.time.Instant;
import java.util.List;

/**
 * レポート詳細（本文・参加者・キー画像を含む）。{@code GET /api/reports/{id}} の応答。
 */
public record ReportDto(
        String id,
        String patientId,
        String studyInstanceUid,
        String seriesInstanceUid,
        String title,
        ReportType reportType,
        ReportStatus status,
        String bodyMarkdown,
        String clinicalHistory,
        String referringPhysician,
        String srSopInstanceUid,
        String koSopInstanceUid,
        String koSeriesInstanceUid,
        String predecessorReportId,
        String predecessorSrSopUid,
        String lockedBy,
        Instant lockedAt,
        Instant createdAt,
        Instant updatedAt,
        List<ParticipantDto> participants,
        List<KeyImageDto> keyImages) {

    public record ParticipantDto(
            String id,
            String name,
            StaffRole staffRole,
            ParticipationType participationType,
            String organization,
            Instant participatedAt) {
    }

    public record KeyImageDto(
            String id,
            String sopInstanceUid,
            String seriesInstanceUid,
            Integer frameNumber,
            String label,
            String annotation,
            int sortOrder) {
    }
}
