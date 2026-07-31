/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * web モードのキー画像 SOPClassUID 解決（QIDO 応答の選択部分）を検証する
 * （`fw/mobile-ui-design.md` §5.2 の 1.）。
 *
 * <p>web では外部 PACS 由来のインスタンスがローカル H2 索引に無いため、そこを引くと確定が必ず
 * 409 になる。QIDO で引いた応答から正しい 1 件を選べることを固定する。
 */
class ReportKeyImageSopClassTest {

    private static Attributes instance(String sopUid, String sopClassUid) {
        Attributes a = new Attributes();
        if (sopUid != null) {
            a.setString(Tag.SOPInstanceUID, VR.UI, sopUid);
        }
        a.setString(Tag.SOPClassUID, VR.UI, sopClassUid);
        return a;
    }

    @Test
    void picksMatchingInstance() {
        List<Attributes> hits = List.of(
                instance("1.2.3.1", UID.CTImageStorage),
                instance("1.2.3.2", UID.MRImageStorage));
        assertEquals(UID.MRImageStorage, ReportService.pickSopClassUid(hits, "1.2.3.2"));
    }

    @Test
    void singleHitWithoutSopInstanceUidIsAccepted() {
        // QIDO 応答に SOPInstanceUID を含めない PACS がある。絞り込みが効いている前提で 1 件なら採る。
        List<Attributes> hits = List.of(instance(null, UID.CTImageStorage));
        assertEquals(UID.CTImageStorage, ReportService.pickSopClassUid(hits, "1.2.3.9"));
    }

    @Test
    void ambiguousHitsWithoutMatchAreRejected() {
        // 2 件以上あって一致が無ければ、どれを指すか決められない。推測して誤った SOP Class を
        // SR に書くより、見つからない（=409）として止める方が安全。
        List<Attributes> hits = List.of(
                instance(null, UID.CTImageStorage),
                instance(null, UID.MRImageStorage));
        assertNull(ReportService.pickSopClassUid(hits, "1.2.3.9"));
    }

    @Test
    void emptyOrNullIsNull() {
        assertNull(ReportService.pickSopClassUid(List.of(), "1.2.3.1"));
        assertNull(ReportService.pickSopClassUid(null, "1.2.3.1"));
    }

    @Test
    void matchWinsOverOrder() {
        // 先頭が一致しないケースでも、UID 一致を優先する（順序に依存しない）。
        List<Attributes> hits = List.of(
                instance("1.2.3.8", UID.SecondaryCaptureImageStorage),
                instance("1.2.3.1", UID.CTImageStorage));
        assertEquals(UID.CTImageStorage, ReportService.pickSopClassUid(hits, "1.2.3.1"));
    }
}
