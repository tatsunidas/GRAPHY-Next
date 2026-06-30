/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** CSV/JSON 整形（ファイル非依存）の検証。 */
class TagExtractFormatTest {

    private static TagExtractService.ExtractResult sample() {
        return new TagExtractService.ExtractResult(
                List.of("SOPInstanceUID", "PatientName (00100010)"),
                List.of(
                        List.of("1.2.3", "Yamada^Taro"),
                        List.of("1.2.4", "Smith, John \"JJ\"")));
    }

    @Test
    void csv_hasBomHeaderAndQuotesSpecialChars() {
        String csv = TagExtractFormat.toCsv(sample());
        assertTrue(csv.startsWith("﻿"), "先頭に UTF-8 BOM");
        String[] lines = csv.split("\r\n");
        assertEquals("﻿SOPInstanceUID,PatientName (00100010)", lines[0]);
        assertEquals("1.2.3,Yamada^Taro", lines[1]);
        // カンマと二重引用符を含む値はクォートし、内部の " は "" にエスケープ
        assertEquals("1.2.4,\"Smith, John \"\"JJ\"\"\"", lines[2]);
    }

    @Test
    void json_isArrayOfColumnKeyedObjects() {
        String json = TagExtractFormat.toJson(sample());
        assertTrue(json.contains("\"SOPInstanceUID\": \"1.2.3\""));
        assertTrue(json.contains("\"PatientName (00100010)\": \"Yamada^Taro\""));
        // 引用符はエスケープされる
        assertTrue(json.contains("Smith, John \\\"JJ\\\""));
        assertTrue(json.trim().startsWith("[") && json.trim().endsWith("]"));
    }

    @Test
    void emptyRows_producesHeaderOnlyCsv() {
        var r = new TagExtractService.ExtractResult(List.of("A", "B"), List.of());
        assertEquals("﻿A,B\r\n", TagExtractFormat.toCsv(r));
        assertEquals("[\n]\n", TagExtractFormat.toJson(r));
    }
}
