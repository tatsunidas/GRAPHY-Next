/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import com.vis.graphynext.extract.TagExtractService.Seg;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 条件評価を DB 抜きで。演算子ごとに「通る値」と「落ちる値」の両方を確かめる。 */
class SeriesConditionEvaluatorTest {

    private static Attributes header() {
        Attributes a = new Attributes();
        a.setString(Tag.SeriesDescription, VR.LO, "Ax T2 FLAIR");
        a.setString(Tag.SliceThickness, VR.DS, "5.0");
        a.setString(Tag.SeriesNumber, VR.IS, "7");
        a.setString(Tag.StudyDate, VR.DA, "20260115");
        a.setString(Tag.Modality, VR.CS, "MR");
        return a;
    }

    private static SearchCondition c(int tag, String vr, boolean exclude, String op, String v1, String v2) {
        return new SearchCondition(List.of(new Seg(String.format("%08X", tag), null)), vr, exclude, op, v1, v2, null);
    }

    private static boolean ok(Attributes h, SearchCondition... cs) {
        return SeriesConditionEvaluator.matches(h, List.of(cs), null);
    }

    @Test
    void string_equals_contains_prefix_suffix() {
        Attributes h = header();
        int d = Tag.SeriesDescription;
        assertTrue(ok(h, c(d, "LO", false, "EQUALS", "ax t2 flair", null)), "完全一致（大文字小文字は区別しない）");
        assertFalse(ok(h, c(d, "LO", false, "EQUALS", "Ax T2", null)), "完全一致は部分では通らない");
        assertTrue(ok(h, c(d, "LO", false, "CONTAINS", "t2", null)));
        assertFalse(ok(h, c(d, "LO", false, "CONTAINS", "DWI", null)));
        assertTrue(ok(h, c(d, "LO", false, "STARTS_WITH", "ax", null)), "前方一致");
        assertFalse(ok(h, c(d, "LO", false, "STARTS_WITH", "T2", null)), "前方一致は途中では通らない");
        assertTrue(ok(h, c(d, "LO", false, "ENDS_WITH", "flair", null)), "後方一致");
        assertFalse(ok(h, c(d, "LO", false, "ENDS_WITH", "Ax", null)), "後方一致は先頭では通らない");
        assertFalse(ok(h, c(d, "LO", false, "STARTS_WITH", "  ", null)), "空の値で全件が通ってはいけない");
    }

    @Test
    void numeric_equals_gt_lt_ge_le_range() {
        Attributes h = header();
        int t = Tag.SliceThickness; // 5.0
        assertTrue(ok(h, c(t, "DS", false, "EQUALS", "5", null)));
        assertFalse(ok(h, c(t, "DS", false, "EQUALS", "5.1", null)));
        assertTrue(ok(h, c(t, "DS", false, "GT", "4.9", null)));
        assertFalse(ok(h, c(t, "DS", false, "GT", "5", null)), "GT は境界を含まない");
        assertTrue(ok(h, c(t, "DS", false, "LT", "5.1", null)));
        assertFalse(ok(h, c(t, "DS", false, "LT", "5", null)), "LT は境界を含まない");
        assertTrue(ok(h, c(t, "DS", false, "GE", "5", null)), "GE は境界を含む");
        assertTrue(ok(h, c(t, "DS", false, "LE", "5", null)), "LE は境界を含む");
        assertTrue(ok(h, c(t, "DS", false, "RANGE", "4", "6")));
        assertFalse(ok(h, c(t, "DS", false, "RANGE", "5.5", "9")));
        assertFalse(ok(h, c(t, "DS", false, "GT", "abc", null)), "数値でない値は不一致");
    }

    @Test
    void date_gt_lt_range() {
        Attributes h = header();
        int d = Tag.StudyDate; // 20260115
        assertTrue(ok(h, c(d, "DA", false, "GT", "20260101", null)));
        assertFalse(ok(h, c(d, "DA", false, "GT", "20260115", null)));
        assertTrue(ok(h, c(d, "DA", false, "LT", "20260201", null)));
        assertTrue(ok(h, c(d, "DA", false, "RANGE", "20260101", "20260131")));
        assertFalse(ok(h, c(d, "DA", false, "RANGE", "20260201", "20260228")));
    }

    @Test
    void exclude_wins_over_include() {
        Attributes h = header();
        assertTrue(ok(h, c(Tag.Modality, "CS", false, "EQUALS", "MR", null)));
        assertFalse(ok(h,
                c(Tag.Modality, "CS", false, "EQUALS", "MR", null),
                c(Tag.SeriesDescription, "LO", true, "CONTAINS", "flair", null)),
                "Include を満たしても Exclude に当たれば不採用");
        assertTrue(ok(h,
                c(Tag.Modality, "CS", false, "EQUALS", "MR", null),
                c(Tag.SeriesDescription, "LO", true, "CONTAINS", "DWI", null)),
                "Exclude に当たらなければ採用");
    }

    @Test
    void missing_tag_does_not_match_include() {
        assertFalse(ok(header(), c(Tag.ProtocolName, "LO", false, "CONTAINS", "x", null)));
    }

    @Test
    void nested_sequence_and_private_tag() {
        Attributes h = header();
        Sequence seq = h.newSequence(Tag.ReferencedImageSequence, 1);
        Attributes item = new Attributes();
        item.setString(Tag.ReferencedSOPInstanceUID, VR.UI, "1.2.3.4");
        seq.add(item);
        h.setString("ACME", 0x00191001, VR.LO, "PRIV-VALUE");

        SearchCondition nested = new SearchCondition(List.of(
                new Seg(String.format("%08X", Tag.ReferencedImageSequence), null),
                new Seg(String.format("%08X", Tag.ReferencedSOPInstanceUID), null)),
                "UI", false, "STARTS_WITH", "1.2", null, null);
        assertTrue(ok(h, nested), "SQ を経由した値で判定できる");

        SearchCondition priv = new SearchCondition(List.of(new Seg("00191001", "ACME")),
                "LO", false, "EQUALS", "priv-value", null, null);
        assertTrue(ok(h, priv), "Private タグ（creator 指定）");
        SearchCondition wrongCreator = new SearchCondition(List.of(new Seg("00191001", "OTHER")),
                "LO", false, "EQUALS", "priv-value", null, null);
        assertFalse(ok(h, wrongCreator), "creator が違えば読めない");
    }

    @Test
    void plane_from_iop() {
        Attributes ax = header();
        ax.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
        Attributes sag = header();
        sag.setDouble(Tag.ImageOrientationPatient, VR.DS, 0, 1, 0, 0, 0, -1);
        Attributes cor = header();
        cor.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 0, -1);
        Attributes obliqueAx = header(); // 軸位を 10 度傾けても法線の優位軸は Z
        obliqueAx.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, Math.cos(Math.toRadians(10)),
                Math.sin(Math.toRadians(10)));
        assertEquals("AXIAL", PlaneUtil.planeOf(ax));
        assertEquals("SAGITTAL", PlaneUtil.planeOf(sag));
        assertEquals("CORONAL", PlaneUtil.planeOf(cor));
        assertEquals("AXIAL", PlaneUtil.planeOf(obliqueAx));
        assertNull(PlaneUtil.planeOf(header()), "IOP が無ければ判定不能");

        assertTrue(SeriesConditionEvaluator.matches(sag, List.of(), List.of("SAGITTAL", "CORONAL")));
        assertFalse(SeriesConditionEvaluator.matches(ax, List.of(), List.of("SAGITTAL", "CORONAL")));
        assertFalse(SeriesConditionEvaluator.matches(header(), List.of(), List.of("AXIAL")), "IOP 無しは断面指定で不採用");
    }
}
