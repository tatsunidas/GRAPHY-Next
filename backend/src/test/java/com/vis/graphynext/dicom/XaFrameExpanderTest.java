/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * XA/XRF シネのレイアウト展開（{@code fw/angio-design.md} §5.2）。
 *
 * <p>ここが壊れると「XA を開いても先頭フレームしか出ない」に戻る。しかも<b>何かは表示される</b>
 * ので壊れて見えない ＝ 自動テストで守る価値が高い。
 */
class XaFrameExpanderTest {

    private static final String XA = "1.2.840.10008.5.1.4.1.1.12.1";
    private static final String ENHANCED_XA = "1.2.840.10008.5.1.4.1.1.12.1.1";
    private static final String CT = "1.2.840.10008.5.1.4.1.1.2";
    /** X-Ray 3D Angiographic（再構成ボリューム）。シネ展開の対象外。 */
    private static final String XA_3D = "1.2.840.10008.5.1.4.1.1.13.1.1";

    private static Attributes run(String sopClass, String sop, int instanceNumber, int frames) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, sopClass);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
        ds.setInt(Tag.InstanceNumber, VR.IS, instanceNumber);
        ds.setInt(Tag.NumberOfFrames, VR.IS, frames);
        ds.setInt(Tag.Rows, VR.US, 512);
        ds.setInt(Tag.Columns, VR.US, 512);
        ds.setInt(Tag.BitsAllocated, VR.US, 8);
        return ds;
    }

    @Test
    void singleRun_framesBecomeTAxis() {
        SeriesLayout l = XaFrameExpander.layout(List.of(run(XA, "1.1", 1, 96)));
        assertNotNull(l);
        assertEquals(1, l.nZ(), "ラン数");
        assertEquals(1, l.nC());
        assertEquals(96, l.nT(), "フレーム数が T 軸に載る");
        assertEquals(96, l.cells().size());
        // t とフレーム番号が一致していること（ここがずれると全フレーム 1 枚ずれる）。
        for (SeriesLayout.Cell c : l.cells()) {
            assertEquals(c.t(), c.frame(), "t とフレーム番号は 1:1");
            assertEquals(0, c.z());
            assertEquals(0, c.c());
        }
    }

    @Test
    void axes_labelsAreRunAndFrame_andStackIsT() {
        SeriesLayout l = XaFrameExpander.layout(List.of(run(XA, "1.1", 1, 30)));
        assertNotNull(l.axes());
        // UI に「Z」と出さないための提示（fw/angio-design.md §5.7）。
        assertEquals("Run", l.axes().z().label());
        assertEquals("run", l.axes().z().kind());
        assertEquals("Frame", l.axes().t().label());
        assertEquals("frame", l.axes().t().kind());
        // スタック軸が T でないと、フレーム送りのたびに setStack が走る。
        assertEquals("t", l.axes().stackAxis());
    }

    @Test
    void multipleRuns_shortRunHoldsLastFrame() {
        SeriesLayout l = XaFrameExpander.layout(List.of(
                run(XA, "1.1", 1, 5),
                run(XA, "1.2", 2, 3)));
        assertNotNull(l);
        assertEquals(2, l.nZ());
        assertEquals(5, l.nT(), "nT は最大フレーム数");
        assertEquals(10, l.cells().size());
        // 短いラン(z=1, 3 フレーム)は t>=3 で最終フレーム(2)に留まる（ブランクを挟まない）。
        for (SeriesLayout.Cell c : l.cells()) {
            if (c.z() == 1) {
                assertEquals(Math.min(c.t(), 2), c.frame());
            }
        }
    }

    @Test
    void runsAreOrderedByInstanceNumber() {
        SeriesLayout l = XaFrameExpander.layout(List.of(
                run(XA, "1.9", 9, 2),
                run(XA, "1.1", 1, 2)));
        assertNotNull(l);
        assertEquals("1.1", l.cells().get(0).sopInstanceUid(), "z=0 は InstanceNumber の小さい方");
    }

    @Test
    void noGeometryIsAttached() {
        // 投影像に患者座標の断面は無い。IOP/ZSpatial/FoR を付けると Sync・参照線・MPR が誤って有効になる。
        SeriesLayout l = XaFrameExpander.layout(List.of(run(XA, "1.1", 1, 10)));
        assertNull(l.imageOrientationPatient());
        assertNull(l.zSpatial());
        assertNull(l.frameOfReferenceUID());
        assertEquals(0.0, l.pixelSpacingRow(), "XA の空間校正は frontend の xaCalibration が担当");
    }

    @Test
    void pixelFormatIsCarried() {
        // メモリガード（全フレーム展開の予測）が働くために必要。
        SeriesLayout l = XaFrameExpander.layout(List.of(run(XA, "1.1", 1, 10)));
        assertNotNull(l.pixelFormat());
        assertEquals(8, l.pixelFormat().bitsAllocated());
        assertEquals(512, l.imageWidth());
        assertEquals(512, l.imageHeight());
    }

    @Test
    void enhancedXaIsAlsoExpanded() {
        assertTrue(XaFrameExpander.isXaCine(run(ENHANCED_XA, "1.1", 1, 40)));
        assertNotNull(XaFrameExpander.layout(List.of(run(ENHANCED_XA, "1.1", 1, 40))));
    }

    /**
     * 単一フレームの XA も<b>フレーム軸</b>として扱う（2026-08-15 に方針変更）。
     *
     * <p>以前はフレーム数 1 の XA を「従来の Z スタック経路でよい」として除外していた。
     * しかし XA は投影像なので Z 軸に意味が無く、除外すると <b>校正・QCA の導線が
     * まるごと出ない</b>（フロントの XA 操作行は {@code stackAxis=="t"} で出し分けている）。
     * GNBP-XA-4 の校正変種が 1 フレームで、実機検証で踏んだ。単一フレームのアンギオや
     * XRF スポット像は実在するので実データでも起きる。
     *
     * <p>フレーム数 1 ならスライダーは出ない（{@code count > 1} ガード）ので、
     * 表示上の副作用は無い。
     */
    @Test
    void singleFrameXa_isStillFrameAxis() {
        assertTrue(XaFrameExpander.isXaCine(run(XA, "1.1", 1, 1)));
        SeriesLayout l = XaFrameExpander.layout(List.of(run(XA, "1.1", 1, 1)));
        assertNotNull(l);
        assertEquals(1, l.nZ());
        assertEquals(1, l.nT());
        assertEquals("t", l.axes().stackAxis());
    }

    @Test
    void xa3dVolumeIsNotCine() {
        // X-Ray 3D Angiographic は再構成ボリューム。Z スタックのままにする。
        assertFalse(XaFrameExpander.isXaCine(run(XA_3D, "1.1", 1, 200)));
        assertNull(XaFrameExpander.layout(List.of(run(XA_3D, "1.1", 1, 200))));
    }

    @Test
    void nonXaSeriesIsUntouched() {
        assertNull(XaFrameExpander.layout(List.of(run(CT, "1.1", 1, 1))));
        assertNull(XaFrameExpander.layout(List.of()));
        assertNull(XaFrameExpander.layout(null));
    }

    @Test
    void mixedSeries_onlyXaCineIsUsed() {
        // XA シネと他が混在したら XA シネのみ採用（混ぜると軸の意味が壊れる）。
        SeriesLayout l = XaFrameExpander.layout(List.of(
                run(CT, "2.1", 1, 1),
                run(XA, "1.1", 2, 4)));
        assertNotNull(l);
        assertEquals(1, l.nZ());
        assertEquals(4, l.nT());
        assertEquals("1.1", l.cells().get(0).sopInstanceUid());
    }
}
