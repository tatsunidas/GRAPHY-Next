package com.vis.graphynext.dicom;

/**
 * スタディ検索の絞り込み条件。各項目は null/空で無条件。
 *
 * @param studyDateFrom 検査日 開始(YYYYMMDD, 含む)
 * @param studyDateTo   検査日 終了(YYYYMMDD, 含む)
 * @param modality      モダリティ（カンマ区切りで複数可。例 "CT,MR"）
 */
public record StudySearch(String patientId, String patientName, String studyDateFrom, String studyDateTo,
                          String modality, String accessionNumber) {

    /** null/空文字を null に正規化したコピー。 */
    public StudySearch normalized() {
        return new StudySearch(blankToNull(patientId), blankToNull(patientName), blankToNull(studyDateFrom),
                blankToNull(studyDateTo), blankToNull(modality), blankToNull(accessionNumber));
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
