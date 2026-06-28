package com.vis.graphynext.dicom;

/**
 * スタディ検索の絞り込み条件。各項目は null/空で無条件。
 */
public record StudySearch(String patientId, String patientName, String studyDate,
                          String modality, String accessionNumber) {

    /** null/空文字を null に正規化したコピー。 */
    public StudySearch normalized() {
        return new StudySearch(blankToNull(patientId), blankToNull(patientName), blankToNull(studyDate),
                blankToNull(modality), blankToNull(accessionNumber));
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
