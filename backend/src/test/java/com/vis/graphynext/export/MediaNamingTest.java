/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** PS3.10 ファイル ID 命名（ファイル非依存）の検証。 */
class MediaNamingTest {

    @Test
    void dirNames_areEightCharUppercase() {
        assertEquals("PAT00001", MediaNaming.dirName("PAT", 1));
        assertEquals("STU00042", MediaNaming.dirName("STU", 42));
        assertEquals("SER99999", MediaNaming.dirName("SER", 99999));
        for (String s : new String[] {
                MediaNaming.dirName("PAT", 1), MediaNaming.dirName("STU", 42), MediaNaming.dirName("SER", 99999)}) {
            assertTrue(MediaNaming.isValidFileId(s), s);
        }
    }

    @Test
    void imageName_isEightDigits() {
        assertEquals("00000001", MediaNaming.imageName(1));
        assertEquals("12345678", MediaNaming.imageName(12345678));
        assertTrue(MediaNaming.isValidFileId(MediaNaming.imageName(1)));
    }

    @Test
    void isValidFileId_rejectsLowercaseLongAndEmpty() {
        assertFalse(MediaNaming.isValidFileId("pat00001")); // 小文字
        assertFalse(MediaNaming.isValidFileId("PATIENT001")); // 9 文字超
        assertFalse(MediaNaming.isValidFileId("IMG.001")); // ドット不可
        assertFalse(MediaNaming.isValidFileId(""));
        assertFalse(MediaNaming.isValidFileId(null));
    }
}
