/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import java.util.List;

/**
 * {@code PUT /api/reports/{id}} のリクエスト本文。{@code null} のフィールドは変更しない
 * （部分更新）が、{@code participants}/{@code keyImages} は渡した時点で全置換する
 * （エディタが毎回フォーム全体を保存する UX に合わせた設計、`fw/report-design.md` §5）。
 *
 * <p>{@code editedBy} はロック確認に使う（ロック保持者と異なる場合は 409）。
 */
public record UpdateReportRequest(
        String title,
        String bodyMarkdown,
        String clinicalHistory,
        String referringPhysician,
        List<ParticipantInput> participants,
        List<KeyImageInput> keyImages,
        String editedBy) {

    public record ParticipantInput(
            String name,
            StaffRole staffRole,
            ParticipationType participationType,
            String organization) {
    }

    public record KeyImageInput(
            String sopInstanceUid,
            String seriesInstanceUid,
            Integer frameNumber,
            String label,
            String annotation,
            int sortOrder) {
    }
}
