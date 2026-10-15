/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import java.util.List;
import java.util.Map;

/**
 * 別の DB フォルダへ運ぶ荷物の目録（{@code <移し先>/inbox/<id>/manifest.json}）。
 *
 * <p>DICOM ファイルは {@code dicom/<study>/<series>/<sop>.dcm} に置き、サイズと sha256 を持つ。
 * 付随データ（レポート・ROI など）は値ごとここに入れる。移し先は次に開いたときにこれを読んで取り込む。
 */
public record TransferManifest(
        int formatVersion,
        String id,
        String createdAt,
        String mode,
        String sourceDbFolder,
        List<String> studyUids,
        List<FileEntry> files,
        Related related) {

    public static final int FORMAT_VERSION = 1;

    /** {@code path} は荷物のフォルダからの相対（{@code /} 区切り）。 */
    public record FileEntry(String path, String studyUid, String seriesUid, String sopUid, long size, String sha256) {
    }

    public record Related(
            List<ReportItem> reports,
            List<GlamItem> glam,
            Map<String, String> calibrations,
            List<PatientDocItem> rois,
            List<PatientDocItem> registrations,
            List<PluginDocItem> plugins) {
    }

    public record ReportItem(
            String id, String patientId, String studyInstanceUid, String seriesInstanceUid, String title,
            String reportType, String status, String bodyMarkdown, String clinicalHistory, String referringPhysician,
            String srSopInstanceUid, String koSopInstanceUid, String koSeriesInstanceUid,
            String predecessorReportId, String predecessorSrSopUid, String createdAt, String updatedAt,
            List<ParticipantItem> participants, List<KeyImageItem> keyImages) {
    }

    public record ParticipantItem(String id, String name, String staffRole, String participationType,
                                  String organization, String participatedAt) {
    }

    public record KeyImageItem(String id, String sopInstanceUid, String seriesInstanceUid, Integer frameNumber,
                               String label, String annotation, int sortOrder) {
    }

    public record GlamItem(String id, String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                           String label, String json, int nBins, int maxRadius, long roiVoxelCount, String savedAt) {
    }

    /** 患者単位の文書（ROI・位置合わせ）。{@code count} は ROI 数・記録数。 */
    public record PatientDocItem(String patientKey, String json, int count) {
    }

    public record PluginDocItem(String pluginId, String patientKey, String json) {
    }
}
