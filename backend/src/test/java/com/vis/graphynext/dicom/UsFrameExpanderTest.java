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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * US マルチフレームのシネ展開。ここが無いと<b>先頭フレームしか出ない</b>（しかも 1 枚は表示されるので
 * 壊れて見えない）。時間のシネだけを展開し、空間（スイープ）の手がかりがあるものと IVUS は奪わない。
 */
class UsFrameExpanderTest {

    private static final String US_MULTI = "1.2.840.10008.5.1.4.1.1.3.1";
    private static final String US_IMAGE = "1.2.840.10008.5.1.4.1.1.6.1";
    private static final String US_VOLUME = "1.2.840.10008.5.1.4.1.1.6.2";

    private static Attributes us(String sopClass, String modality, String sop, int instanceNumber, Integer frames) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, sopClass);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
        ds.setString(Tag.Modality, VR.CS, modality);
        ds.setInt(Tag.InstanceNumber, VR.IS, instanceNumber);
        if (frames != null) {
            ds.setInt(Tag.NumberOfFrames, VR.IS, frames);
        }
        ds.setInt(Tag.Rows, VR.US, 480);
        ds.setInt(Tag.Columns, VR.US, 640);
        ds.setInt(Tag.BitsAllocated, VR.US, 8);
        return ds;
    }

    /** 実データ（SonoSite の心エコー・120 フレーム）と同じ形: FIP は Frame Time、位置情報なし。 */
    private static Attributes cine(String sop, int instanceNumber, int frames) {
        Attributes ds = us(US_MULTI, "US", sop, instanceNumber, frames);
        ds.setInt(Tag.FrameIncrementPointer, VR.AT, Tag.FrameTime);
        ds.setString(Tag.FrameTime, VR.DS, "33.333");
        return ds;
    }

    @Test
    void cine_framesBecomeTAxis_asOneShot() {
        SeriesLayout l = UsFrameExpander.layout(List.of(cine("1.1", 1, 120)));
        assertNotNull(l);
        assertEquals(1, l.nZ(), "ショット数");
        assertEquals(120, l.nT(), "フレーム数が T 軸に載る");
        assertEquals(120, l.cells().size());
        for (SeriesLayout.Cell c : l.cells()) {
            assertEquals(c.t(), c.frame(), "t とフレーム番号は 1:1");
        }
        assertEquals("Shot", l.axes().z().label());
        assertEquals("shot", l.axes().z().kind());
        assertEquals("Frame", l.axes().t().label());
        assertEquals("t", l.axes().stackAxis());
        assertNull(l.imageOrientationPatient(), "幾何は付けない");
        assertNull(l.zSpatial());
    }

    @Test
    void multipleShots_shortShotIsNotPadded_andOrderedByInstanceNumber() {
        SeriesLayout l = UsFrameExpander.layout(List.of(cine("1.9", 9, 5), cine("1.1", 1, 3)));
        assertNotNull(l);
        assertEquals(2, l.nZ());
        assertEquals(5, l.nT(), "nT は最大フレーム数");
        assertEquals(8, l.cells().size(), "3 + 5。短いショットを最終フレームで埋めない");
        assertEquals("1.1", l.cells().get(0).sopInstanceUid(), "z=0 は InstanceNumber の小さい方");
    }

    @Test
    void frameTimeVector_isTime() {
        Attributes ds = us(US_MULTI, "US", "1.1", 1, 30);
        ds.setInt(Tag.FrameIncrementPointer, VR.AT, Tag.FrameTimeVector);
        assertNotNull(UsFrameExpander.layout(List.of(ds)));
    }

    @Test
    void noPointerAndNoPosition_isTreatedAsCine() {
        // FIP が無い・位置も無い。空間の手がかりが無いので、時間のシネとして並べる（先頭 1 枚よりまし）。
        assertNotNull(UsFrameExpander.layout(List.of(us(US_MULTI, "US", "1.1", 1, 30))));
    }

    @Test
    void usImageSopClassWithManyFramesIsAlsoExpanded() {
        assertNotNull(UsFrameExpander.layout(List.of(us(US_IMAGE, "US", "1.1", 1, 12))));
    }

    @Test
    void spatialClues_returnNull_soASweepIsNeverLabelledAsTime() {
        // フレームの並びが時間でなく空間の手がかり。時間のシネとして並べると軸の意味が嘘になる。
        Attributes sliceVector = cine("1.1", 1, 60);
        sliceVector.setInt(Tag.FrameIncrementPointer, VR.AT, Tag.SliceLocation); // 時間を指さない FIP
        assertNull(UsFrameExpander.layout(List.of(sliceVector)), "FIP が時間を指さない");

        Attributes ipp = cine("1.2", 1, 60);
        ipp.setDouble(Tag.ImagePositionPatient, VR.DS, 0, 0, 0);
        assertNull(UsFrameExpander.layout(List.of(ipp)), "IPP がある");

        Attributes iop = cine("1.3", 1, 60);
        iop.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
        assertNull(UsFrameExpander.layout(List.of(iop)), "IOP がある");

        Attributes perFrame = cine("1.4", 1, 60);
        perFrame.newSequence(Tag.PerFrameFunctionalGroupsSequence, 1).add(new Attributes());
        assertNull(UsFrameExpander.layout(List.of(perFrame)), "Per-Frame グループがある");
    }

    @Test
    void oneSpatialShotMakesTheWholeSeriesFallBack() {
        Attributes sweep = cine("1.2", 2, 60);
        sweep.setDouble(Tag.ImagePositionPatient, VR.DS, 0, 0, 0);
        assertNull(UsFrameExpander.layout(List.of(cine("1.1", 1, 60), sweep)));
    }

    @Test
    void singleFrameUsOnly_staysOnTheClassicPath() {
        assertNull(UsFrameExpander.layout(List.of(us(US_IMAGE, "US", "1.1", 1, null), us(US_IMAGE, "US", "1.2", 2, 1))));
    }

    @Test
    void ivusIsNotStolen_andEnhancedUsVolumeIsNotHandled() {
        Attributes ivus = cine("1.1", 1, 300);
        ivus.setString(Tag.Modality, VR.CS, "IVUS");
        assertNull(UsFrameExpander.layout(List.of(ivus)), "IVUS は IvusFrameExpander の担当");
        assertNull(UsFrameExpander.layout(List.of(us(US_VOLUME, "US", "1.1", 1, 80))), "Enhanced US Volume は Z/C/T");
    }

    @Test
    void assembler_dispatchesUsAfterIvus() {
        SeriesLayout l = SeriesLayoutAssembler.fromAttributes(List.of(cine("1.1", 1, 120)));
        assertEquals(120, l.nT(), "web の経路でも展開される（standalone と同じ振り分け）");
        assertEquals("shot", l.axes().z().kind());

        Attributes ivus = cine("2.1", 1, 300);
        ivus.setString(Tag.Modality, VR.CS, "IVUS");
        SeriesLayout p = SeriesLayoutAssembler.fromAttributes(List.of(ivus));
        assertEquals("pullback", p.axes().z().kind(), "IVUS は従来どおり pullback");
    }
}
