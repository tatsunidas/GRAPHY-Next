/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.qr.DimseOutcome.Kind;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 相手の返事の分類。入力は、dcm4che 5.34.3 の findscu / getscu / movescu を偽 SCP に向けて
 * 実際に走らせて採った出力（{@code src/test/resources/findscu-output/}）。
 */
class DimseOutcomeTest {

    private static DimseOutcome parse(String name) throws IOException {
        String txt = Files.readString(Path.of("src/test/resources/findscu-output/" + name + ".txt"));
        int nl = txt.indexOf('\n');
        int exit = Integer.parseInt(txt.substring("exit=".length(), nl).trim());
        return DimseOutcome.parse(exit, txt.substring(nl + 1));
    }

    @Test
    void success() throws IOException {
        assertEquals(Kind.OK, parse("find-ok").kind());
        assertEquals(Kind.OK, parse("get-ok").kind());
        assertEquals(Kind.OK, parse("move-ok").kind());
        assertEquals(Kind.OK, parse("find-drop-minimal-ok").kind());
    }

    @Test
    void errorStatusWithExitZero_isNotSuccess() throws IOException {
        // 🔴 終了コードは 0。ここを成功と読むと、相手の拒否が「0 件」に見える
        DimseOutcome a = parse("find-a900");
        assertEquals(Kind.STATUS_ERROR, a.kind());
        assertEquals(0xA900, a.status());
        assertEquals("fake error", a.errorComment());
        DimseOutcome c = parse("find-c000");
        assertEquals(Kind.STATUS_ERROR, c.kind());
        assertEquals(0xC000, c.status());
    }

    @Test
    void moveDestinationUnknown() throws IOException {
        DimseOutcome o = parse("move-a801");
        assertEquals(Kind.STATUS_ERROR, o.kind());
        assertEquals(0xA801, o.status());
        assertTrue(o.errorComment().contains("Unknown AE"));
    }

    @Test
    void serviceRefused() throws IOException {
        for (String n : new String[] {"find-no-qr", "find-patientroot-unsupported", "get-no-qr"}) {
            DimseOutcome o = parse(n);
            assertEquals(Kind.SERVICE_REFUSED, o.kind(), n);
            assertNull(o.status(), n);
        }
    }

    @Test
    void associationRejected() throws IOException {
        DimseOutcome o = parse("find-rj-called-aet");
        assertEquals(Kind.ASSOCIATION_REJECTED, o.kind());
        assertEquals("called-AE-title-not-recognized", o.reason());
    }

    @Test
    void pspStyleDrop_isDroppedNotUnknown() throws IOException {
        // 実例: findscu(STUDY) 失敗 (exit=2): i/o exception: java.io.EOFException in State: Sta6
        DimseOutcome o = parse("find-drop");
        assertEquals(Kind.DROPPED, o.kind());
        assertNull(o.status());
    }

    @Test
    void unreachable() throws IOException {
        assertEquals(Kind.UNREACHABLE, parse("find-refused").kind());
    }

    @Test
    void unparseableNonZeroExit_isUnknown_andZeroWithoutStatus_isOk() {
        assertEquals(Kind.UNKNOWN, DimseOutcome.parse(1, "something odd").kind());
        assertEquals(Kind.UNKNOWN, DimseOutcome.parse(2, null).kind());
        assertEquals(Kind.OK, DimseOutcome.parse(0, "").kind());
    }

    @Test
    void warningStatusIsOk() {
        assertEquals(Kind.OK, DimseOutcome.parse(0, "x >> 1:C-MOVE-RSP[pcid=1, status=b000H, errorComment=w").kind());
    }
}
