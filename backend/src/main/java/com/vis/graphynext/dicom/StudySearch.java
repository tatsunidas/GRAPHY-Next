/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

/**
 * スタディ検索の絞り込み条件。各項目は null/空で無条件。
 *
 * @param studyDateFrom 検査日 開始(YYYYMMDD, 含む)
 * @param studyDateTo   検査日 終了(YYYYMMDD, 含む)
 * @param modality      モダリティ（カンマ区切りで複数可。例 "CT,MR"）
 * @param onlyMissingPatientInfo true で、患者 ID か氏名が空（null・空文字）のものだけ。匿名化などで空になった検査を
 *                      見つけるための条件で、部分一致の検索（空には何も一致しない）では拾えない
 */
public record StudySearch(String patientId, String patientName, String studyDateFrom, String studyDateTo,
                          String modality, String accessionNumber, boolean onlyMissingPatientInfo) {

    public StudySearch(String patientId, String patientName, String studyDateFrom, String studyDateTo,
                       String modality, String accessionNumber) {
        this(patientId, patientName, studyDateFrom, studyDateTo, modality, accessionNumber, false);
    }

    /** null/空文字を null に正規化したコピー。 */
    public StudySearch normalized() {
        return new StudySearch(blankToNull(patientId), blankToNull(patientName), blankToNull(studyDateFrom),
                blankToNull(studyDateTo), blankToNull(modality), blankToNull(accessionNumber), onlyMissingPatientInfo);
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
