/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** dcm4che 辞書によるタグ → keyword/VR 解決の検証（Spring 不要）。 */
class DicomTagControllerTest {

    private final DicomTagController controller = new DicomTagController();

    @Test
    void resolvesStandardTags() {
        Map<String, String> pn = controller.tag("00100010");
        assertEquals("PatientName", pn.get("keyword"));
        assertEquals("PN", pn.get("vr"));

        // カンマ/括弧入りでも正規化される
        Map<String, String> sd = controller.tag("(0008,103E)");
        assertEquals("SeriesDescription", sd.get("keyword"));
        assertEquals("0008103E", sd.get("tag"));
    }

    @Test
    void unknownOrMalformed_returnsEmpty() {
        Map<String, String> bad = controller.tag("xyz");
        assertEquals("", bad.get("keyword"));
        assertEquals("", bad.get("vr"));
    }
}
