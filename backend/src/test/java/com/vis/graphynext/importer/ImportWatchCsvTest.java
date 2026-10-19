/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 被験者 CSV の解析と検査（純関数）。1 つでも不正があれば全体を拒否する。 */
class ImportWatchCsvTest {

    private static final String H = "PatientID,PatientName,PatientBirthDate,PatientSex\n";

    @Test
    void 正しいCSVは指定のあった列だけを返す() {
        ImportWatchCsv.Parsed p = ImportWatchCsv.parse(H + "S-1,Yamada^Taro,19800102,M\n");
        assertTrue(p.ok());
        assertEquals(Map.of("PatientID", "S-1", "PatientName", "Yamada^Taro", "PatientBirthDate", "19800102",
                "PatientSex", "M"), p.values());
    }

    @Test
    void BOM_CRLF_クォート_空の値_末尾の改行なし() {
        ImportWatchCsv.Parsed p = ImportWatchCsv.parse("﻿PatientID,PatientName,PatientSex\r\n\"A,B\",\"Say \"\"hi\"\"\",\r\n");
        assertTrue(p.ok(), p.error());
        assertEquals("A,B", p.values().get("PatientID"));
        assertEquals("Say \"hi\"", p.values().get("PatientName"));
        assertFalse(p.values().containsKey("PatientSex"), "空の値は指定なし");
        assertTrue(ImportWatchCsv.parse("PatientID\nX").ok(), "末尾に改行が無くてもよい");
        assertTrue(ImportWatchCsv.parse("PatientID\n\nX\n\n").ok(), "空行は無視する");
    }

    @Test
    void 不正は全体を拒否し_何も返さない() {
        assertEquals("csv-empty", ImportWatchCsv.parse("").error());
        assertEquals("csv-empty", ImportWatchCsv.parse("\n\n").error());
        assertEquals("csv-unknown-column", ImportWatchCsv.parse("PatientID,Foo\nA,b\n").error());
        assertEquals("csv-unknown-column", ImportWatchCsv.parse("Key,PatientID\nk,A\n").error(), "Key 列は無い（1 フォルダ = 1 患者）");
        assertEquals("csv-duplicate-column:PatientID", ImportWatchCsv.parse("PatientID,PatientID\nA,B\n").error());
        assertEquals("csv-rows", ImportWatchCsv.parse("PatientID\n").error(), "データ行が 0");
        assertEquals("csv-rows", ImportWatchCsv.parse("PatientID\nA\nB\n").error(), "データ行が 2 以上");
        assertEquals("csv-rows", ImportWatchCsv.parse("PatientID\nA,extra\n").error(), "列より多い値");
        assertEquals("csv-bad-value:PatientBirthDate", ImportWatchCsv.parse(H + "S,N,1980-01-02,M\n").error());
        assertEquals("csv-bad-value:PatientBirthDate", ImportWatchCsv.parse(H + "S,N,19801301,M\n").error());
        assertEquals("csv-bad-value:PatientSex", ImportWatchCsv.parse(H + "S,N,19800102,X\n").error());
        assertEquals("csv-bad-value:PatientID", ImportWatchCsv.parse("PatientID\n" + "x".repeat(65) + "\n").error());
        assertEquals("csv-bad-value:PatientID", ImportWatchCsv.parse("PatientID\n\"a\\b\"\n").error());
        assertEquals("csv-bad-value:Modality", ImportWatchCsv.parse("Modality\nmr\n").error());
        assertTrue(ImportWatchCsv.parse("Foo\nbar\n").values().isEmpty());
    }

    @Test
    void 不正な値が1つでもあれば_ほかの列の有効な値も返さない() {
        ImportWatchCsv.Parsed p = ImportWatchCsv.parse(H + "S-1,Yamada^Taro,19800102,Z\n");
        assertEquals("csv-bad-value:PatientSex", p.error());
        assertTrue(p.values().isEmpty(), "部分適用しない");
    }

    @Test
    void 理由のコードに値そのものは含まない() {
        String secret = "SECRET-PATIENT-NAME-9999";
        ImportWatchCsv.Parsed p = ImportWatchCsv.parse("PatientName,PatientSex\n" + secret + ",Q\n");
        assertFalse(p.error().contains(secret));
    }

    @Test
    void 検査は_NIfTI_だけに効く列も受け付ける() {
        ImportWatchCsv.Parsed p = ImportWatchCsv.parse("PatientID,Modality,StudyDescription\nS,MR,Brain study\n");
        assertTrue(p.ok());
        assertEquals("MR", p.values().get("Modality"));
        assertEquals("Brain study", p.values().get("StudyDescription"));
    }
}
