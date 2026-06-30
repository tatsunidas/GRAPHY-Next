/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** 保存ファイル名（患者 ID 付与・サニタイズ）の検証。 */
class ExportFilenameTest {

    @Test
    void singlePatient_appendsId() {
        assertEquals("graphy-export_PID-1.zip", ExportController.exportFilename(List.of("PID-1")));
    }

    @Test
    void multiplePatients_showsFirstPlusCount() {
        assertEquals("graphy-export_A_+2.zip", ExportController.exportFilename(List.of("A", "B", "C")));
    }

    @Test
    void emptyOrBlank_fallsBack() {
        assertEquals("graphy-export.zip", ExportController.exportFilename(List.of()));
        assertEquals("graphy-export.zip", ExportController.exportFilename(List.of("", "  ")));
    }

    @Test
    void unsafeChars_areReplaced() {
        assertEquals("graphy-export_a_b_c.zip", ExportController.exportFilename(List.of("a/b\\c")));
    }
}
