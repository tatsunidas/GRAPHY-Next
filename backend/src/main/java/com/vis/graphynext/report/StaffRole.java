/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

/**
 * レポート参加者の職種（DICOM CID 7452 Organizational Role 相当のコードを保持）。
 *
 * <p>GRAPHY-Next にはログイン・認証機構が無いため、これは記述的メタデータであり
 * アクセス制御ではない（旧 GRAPHY {@code com.vis.core.reporting.StaffRole} と同じ位置付け）。
 * 標準コードが無い職種は private scheme（99GRAPHYNEXT）を用いる。
 */
public enum StaffRole {
    PHYSICIAN("SCT", "309343006", "Physician"),
    RADIOLOGIC_TECHNOLOGIST("SCT", "159016003", "Radiographer"),
    MEDICAL_ASSISTANT("99GRAPHYNEXT", "MEDASST", "Medical Assistant"),
    CLERICAL_WORKER("99GRAPHYNEXT", "CLERICAL", "Clerical Worker"),
    SCIENTIST("99GRAPHYNEXT", "SCIENTIST", "Scientist");

    private final String codingSchemeDesignator;
    private final String codeValue;
    private final String codeMeaning;

    StaffRole(String codingSchemeDesignator, String codeValue, String codeMeaning) {
        this.codingSchemeDesignator = codingSchemeDesignator;
        this.codeValue = codeValue;
        this.codeMeaning = codeMeaning;
    }

    public String codingSchemeDesignator() {
        return codingSchemeDesignator;
    }

    public String codeValue() {
        return codeValue;
    }

    public String codeMeaning() {
        return codeMeaning;
    }
}
