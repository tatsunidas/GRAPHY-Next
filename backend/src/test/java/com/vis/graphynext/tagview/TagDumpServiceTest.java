/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.tagview;

import com.vis.graphynext.tagview.TagDumpService.TagRow;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 属性ダンプの走査（ネスト SQ の深さ・アイテム区切り）の検証。ファイル非依存。 */
class TagDumpServiceTest {

    @Test
    void flatAttributes_emitOneRowEach() {
        Attributes ds = new Attributes();
        ds.setString(Tag.PatientName, VR.PN, "Yamada^Taro");
        ds.setString(Tag.PatientID, VR.LO, "PID-1");
        List<TagRow> out = new ArrayList<>();
        TagDumpService.walk(ds, 0, out);
        assertEquals(2, out.size());
        // tags() は昇順 → PatientName(0010,0010) が先
        assertEquals(0, out.get(0).depth());
        assertEquals("(0010,0010)", out.get(0).tag());
        assertEquals("PatientName", out.get(0).name());
        assertEquals("PN", out.get(0).vr());
        assertEquals("Yamada^Taro", out.get(0).value());
    }

    @Test
    void sequence_isNestedWithItemMarkersAndDepth() {
        Attributes ds = new Attributes();
        ds.setString(Tag.PatientID, VR.LO, "PID-1");
        Sequence seq = ds.newSequence(Tag.RequestAttributesSequence, 2);
        Attributes item1 = new Attributes();
        item1.setString(Tag.ScheduledProcedureStepID, VR.SH, "SPS-1");
        seq.add(item1);
        Attributes item2 = new Attributes();
        item2.setString(Tag.ScheduledProcedureStepID, VR.SH, "SPS-2");
        seq.add(item2);

        List<TagRow> out = new ArrayList<>();
        TagDumpService.walk(ds, 0, out);

        // 期待: PatientID(d0), SQ(d0), Item#1(d1), SPS(d2), Item#2(d1), SPS(d2)
        assertEquals(6, out.size());
        TagRow sq = out.stream().filter(r -> "SQ".equals(r.vr())).findFirst().orElseThrow();
        assertEquals(0, sq.depth());
        assertEquals("", sq.value());

        List<TagRow> items = out.stream().filter(r -> r.name().startsWith("Item #")).toList();
        assertEquals(2, items.size());
        assertEquals(1, items.get(0).depth());
        assertEquals("(FFFE,E000)", items.get(0).tag());

        List<TagRow> sps = out.stream().filter(r -> "ScheduledProcedureStepID".equals(r.name())).toList();
        assertEquals(2, sps.size());
        assertTrue(sps.stream().allMatch(r -> r.depth() == 2), "ネスト属性は depth=2");
        assertEquals("SPS-1", sps.get(0).value());
        assertEquals("SPS-2", sps.get(1).value());
    }
}
