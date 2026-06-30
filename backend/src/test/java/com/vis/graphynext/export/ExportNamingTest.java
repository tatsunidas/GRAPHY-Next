/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 可読フォルダ/ファイル名生成（ファイル非依存）の検証。 */
class ExportNamingTest {

    @Test
    void safeName_replacesWindowsForbiddenChars() {
        assertEquals("a_b_c_d", ExportNaming.safeName("a/b\\c:d", "x"));
        assertEquals("CT_Chest_W_O", ExportNaming.safeName("CT Chest W/O", "x").replace(" ", "_"));
        // 末尾のドット・空白は除去
        assertEquals("name", ExportNaming.safeName("name. ", "x"));
    }

    @Test
    void safeName_fallsBackWhenEmptyOrAllStripped() {
        assertEquals("FB", ExportNaming.safeName("", "FB"));
        assertEquals("FB", ExportNaming.safeName(null, "FB"));
        assertEquals("FB", ExportNaming.safeName("...", "FB"));
    }

    @Test
    void safeName_avoidsReservedDeviceNames() {
        assertEquals("_CON", ExportNaming.safeName("CON", "x"));
        assertEquals("_nul", ExportNaming.safeName("nul", "x"));
    }

    @Test
    void formatStudyDate_yyyymmddToHyphenated() {
        assertEquals("2026-06-30", ExportNaming.formatStudyDate("20260630"));
        assertEquals("2026-06-30", ExportNaming.formatStudyDate("20260630120000"));
        assertTrue(null == ExportNaming.formatStudyDate("2026"));
        assertTrue(null == ExportNaming.formatStudyDate(null));
        assertTrue(null == ExportNaming.formatStudyDate("abcdefgh"));
    }

    @Test
    void unique_disambiguatesWithinParent() {
        Set<String> used = new HashSet<>();
        assertEquals("CT", ExportNaming.unique("CT", used));
        assertEquals("CT_2", ExportNaming.unique("CT", used));
        assertEquals("CT_3", ExportNaming.unique("CT", used));
        assertEquals("MR", ExportNaming.unique("MR", used));
    }

    @Test
    void imageName_isPaddedWithDcm() {
        assertEquals("00000001.dcm", ExportNaming.imageName(1));
        assertFalse(ExportNaming.imageName(1).contains("/"));
    }
}
