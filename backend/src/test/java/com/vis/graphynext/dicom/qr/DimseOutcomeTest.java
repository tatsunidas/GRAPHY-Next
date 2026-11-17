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
    void qrContextRefusedInTheAssociation_thenTheyCloseTheSocket_isRefusedNotDropped() throws IOException {
        // 実機（PSP）: A-ASSOCIATE-AC で Q/R の SOP クラスが result: 3 で拒否され、そのあと EOF。切断ではなく、サービスの拒否
        DimseOutcome o = parse("find-pc-refused-then-eof");
        assertEquals(Kind.SERVICE_REFUSED, o.kind());
        assertEquals("abstract-syntax-not-supported", o.reason());
        // 転送構文の拒否（result: 4）は、理由を区別して返す
        DimseOutcome t = parse("get-pc-ts-refused");
        assertEquals(Kind.SERVICE_REFUSED, t.kind());
        assertEquals("transfer-syntaxes-not-supported", t.reason());
    }

    @Test
    void storagePcRejectionsAlone_doNotMakeItARefusal_andAcceptedQrPcThenEofIsStillDropped() throws IOException {
        // GET の成功: Q/R の PC は受理（result: 0）、保存用の PC は多数が拒否（result: 3）。これは拒否ではない
        assertEquals(Kind.OK, parse("get-ok").kind());
        // Q/R の PC は受理されたうえで、要求を送ったあとに切られた: 従来どおり「切断」
        assertEquals(Kind.DROPPED, parse("find-drop").kind());
    }

    private static Dcm4cheTools.Result timedOut(String out) {
        return new Dcm4cheTools.Result(-1, out, true);
    }

    @Test
    void timedOut_withTheFinalStatusAlreadyReceived_isOk_becauseOnlyTheReleaseHung() {
        // 実機（PSP）: C-FIND-RSP status 0H を受け取ったあと、A-RELEASE-RP を待って止まり、強制終了した
        String out = "... >> 1:C-FIND-RSP[pcid=1, status=0H\n11:00:00.000 DEBUG - GN->PEER(1): enter state: Sta7 - Awaiting A-RELEASE-RP PDU\n";
        DimseOutcome o = DimseOutcome.parse(timedOut(out));
        assertEquals(Kind.OK, o.kind());
        assertEquals(0, o.status());
        // 受け取った status がエラーなら、時間切れでなくそのエラー
        DimseOutcome e = DimseOutcome.parse(timedOut(">> 1:C-FIND-RSP[pcid=1, status=a900H, errorComment=x\n"));
        assertEquals(Kind.STATUS_ERROR, e.kind());
    }

    @Test
    void timedOut_withoutAStatus_isATimeout_andSaysWhereItStopped() {
        for (String[] c : new String[][] {
                {"Sta5 - Awaiting A-ASSOCIATE-AC or A-ASSOCIATE-RJ PDU", "Sta5"},
                {"Sta6 - Association established and ready for data transfer", "Sta6"},
                {"Sta7 - Awaiting A-RELEASE-RP PDU", "Sta7"}}) {
            DimseOutcome o = DimseOutcome.parse(timedOut("11:00:00.000 DEBUG - GN->PEER(1): enter state: " + c[0] + "\n"));
            assertEquals(Kind.TIMEOUT, o.kind(), c[1]);
            assertTrue(o.reason().startsWith(c[1]), o.reason());
        }
        // 最後の状態が使われる（途中の状態でなく）
        DimseOutcome last = DimseOutcome.parse(timedOut("enter state: Sta5 - a\nenter state: Sta6 - b\nenter state: Sta7 - c\n"));
        assertEquals("Sta7 - c", last.reason());
        // 何も出ていないなら、理由は無し
        DimseOutcome none = DimseOutcome.parse(timedOut(""));
        assertEquals(Kind.TIMEOUT, none.kind());
        assertNull(none.reason());
    }

    @Test
    void timedOut_afterTheQrContextWasRefused_staysAServiceRefusal() throws IOException {
        // 拒否されたあとに止まった（切断でも時間切れでもなく、サービスの拒否が原因）
        String txt = Files.readString(Path.of("src/test/resources/findscu-output/find-pc-refused-then-eof.txt"));
        assertEquals(Kind.SERVICE_REFUSED, DimseOutcome.parse(timedOut(txt.substring(txt.indexOf('\n') + 1))).kind());
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
