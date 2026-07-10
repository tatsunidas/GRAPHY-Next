/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import org.dcm4che3.data.Code;

/**
 * {@link SrWriter} が使うコード化概念。標準コードは DICOM 標準（PS3.16）で確認済みのもののみ使用し、
 * 対応する標準コードが無い/自信が持てないものは private scheme（99GRAPHYNEXT）にする
 * （{@link StaffRole} と同じ方針）。
 */
final class SrCodes {

    private SrCodes() {
    }

    /** SR ルートコンテナの文書タイトル（LOINC 18748-4, TID 2000 のルート概念として広く使われる）。 */
    static final Code DOC_TITLE_IMAGING_REPORT = new Code("18748-4", "LN", null, "Diagnostic Imaging Report");

    /** 臨床歴（DCM 121060, Mammography CAD SR 等で使われる標準コード）。 */
    static final Code HISTORY = new Code("121060", "DCM", null, "History");

    /** キー画像（DCM 113000 "Of Interest"、Key Object Selection Document のルート概念と共通）。 */
    static final Code KEY_IMAGE = new Code("113000", "DCM", null, "Of Interest");

    /** レポート本文（Markdown を平文化したもの）。単一の標準コードに対応しないため private scheme。 */
    static final Code REPORT_BODY = new Code("REPORTBODY", "99GRAPHYNEXT", null, "Report Body");
}
