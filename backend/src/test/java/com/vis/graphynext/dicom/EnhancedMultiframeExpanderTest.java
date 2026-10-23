/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Enhanced CT/MR のマルチフレーム展開。ここが無いと<b>先頭フレームしか出ない</b>。
 * 判定は SOP クラスで、全 SOP が 1 フレーム（VSRAD 型）・古典 MR・解釈できないものは奪わない（null）。
 *
 * <p>ヘッダは自分の仮定で作った合成なので、合格は実サンプル（eCT_Supplemental ほか）の確認と併せて読むこと。
 */
class EnhancedMultiframeExpanderTest {

    private static final String ENH_CT = "1.2.840.10008.5.1.4.1.1.2.1";
    private static final String ENH_MR = "1.2.840.10008.5.1.4.1.1.4.1";
    private static final String CLASSIC_MR = "1.2.840.10008.5.1.4.1.1.4";
    private static final double[] AXIAL = { 1, 0, 0, 0, 1, 0 };

    /** @param zs 各フレームの Z（mm）。@param temporal 各フレームの TemporalPositionIndex（null なら書かない） */
    private static Attributes enhanced(String sopClass, String sop, int instanceNumber, double[] zs,
            int[] temporal, int[][] dimValues, int[] dimPointers, double[] iop) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, sopClass);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
        ds.setInt(Tag.InstanceNumber, VR.IS, instanceNumber);
        ds.setInt(Tag.NumberOfFrames, VR.IS, zs.length);
        ds.setInt(Tag.Rows, VR.US, 64);
        ds.setInt(Tag.Columns, VR.US, 64);
        ds.setInt(Tag.BitsAllocated, VR.US, 16);
        ds.setString(Tag.FrameOfReferenceUID, VR.UI, "1.2.3");
        if (dimPointers != null) {
            Sequence dis = ds.newSequence(Tag.DimensionIndexSequence, dimPointers.length);
            for (int p : dimPointers) {
                Attributes item = new Attributes();
                item.setInt(Tag.DimensionIndexPointer, VR.AT, p);
                dis.add(item);
            }
        }
        Attributes shared = new Attributes();
        Attributes pm = new Attributes();
        pm.setDouble(Tag.PixelSpacing, VR.DS, 0.5, 0.5);
        shared.newSequence(Tag.PixelMeasuresSequence, 1).add(pm);
        if (iop != null) {
            Attributes po = new Attributes();
            po.setDouble(Tag.ImageOrientationPatient, VR.DS, iop);
            shared.newSequence(Tag.PlaneOrientationSequence, 1).add(po);
        }
        ds.newSequence(Tag.SharedFunctionalGroupsSequence, 1).add(shared);
        Sequence pf = ds.newSequence(Tag.PerFrameFunctionalGroupsSequence, zs.length);
        for (int i = 0; i < zs.length; i++) {
            Attributes f = new Attributes();
            if (!Double.isNaN(zs[i])) {
                Attributes pp = new Attributes();
                pp.setDouble(Tag.ImagePositionPatient, VR.DS, 0, 0, zs[i]);
                f.newSequence(Tag.PlanePositionSequence, 1).add(pp);
            }
            Attributes fc = new Attributes();
            if (temporal != null) {
                fc.setInt(Tag.TemporalPositionIndex, VR.UL, temporal[i]);
            }
            if (dimValues != null) {
                fc.setInt(Tag.DimensionIndexValues, VR.UL, dimValues[i]);
            }
            f.newSequence(Tag.FrameContentSequence, 1).add(fc);
            pf.add(f);
        }
        return ds;
    }

    private static Attributes simple(double[] zs) {
        return enhanced(ENH_CT, "1.1", 1, zs, null, null, null, AXIAL);
    }

    @Test
    void sopClassUids_areTheRealOnes() {
        // 実サンプル（eCT_Supplemental）の SOP クラス。2.2 は Legacy Converted で別物。
        assertTrue(EnhancedMultiframeExpander.isEnhanced(simple(new double[] { 0 })));
        Attributes legacy = simple(new double[] { 0 });
        legacy.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.2.2");
        assertTrue(EnhancedMultiframeExpander.isEnhanced(legacy));
        Attributes classic = simple(new double[] { 0 });
        classic.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.2");
        assertTrue(!EnhancedMultiframeExpander.isEnhanced(classic), "古典 CT は対象外");
    }

    @Test
    void multiFrameBecomesZStack_withLoaderFrames() {
        SeriesLayout l = EnhancedMultiframeExpander.layout(List.of(simple(new double[] { 30, 10, 20 })));
        assertNotNull(l);
        assertEquals(3, l.nZ());
        assertEquals(1, l.nC());
        assertEquals(1, l.nT());
        assertEquals(3, l.cells().size());
        assertTrue(l.axes().loaderFrames(), "ローダー切り出しの合図");
        assertEquals("z", l.axes().stackAxis(), "Z スタックのまま");
        // 位置の昇順に z が振られ、フレーム番号は元のまま
        for (SeriesLayout.Cell c : l.cells()) {
            double expectedZ = switch (c.frame()) { case 0 -> 30; case 1 -> 10; default -> 20; };
            assertEquals(expectedZ, l.zSpatial().get(c.z()).imagePositionPatient()[2], 1e-9);
        }
        assertEquals(0.5, l.pixelSpacingRow());
        assertEquals("1.2.3", l.frameOfReferenceUID());
    }

    @Test
    void allSingleFrame_returnsNull_soTheClassicPathKeepsReadingIt() {
        // VSRAD 型: Enhanced でも 1 スライス = 1 ファイル（同じ UID）。従来経路で読めているので奪わない。
        Attributes a = enhanced(ENH_MR, "1.1", 1, new double[] { 0 }, null, null, null, AXIAL);
        Attributes b = enhanced(ENH_MR, "1.2", 2, new double[] { 5 }, null, null, null, AXIAL);
        assertNull(EnhancedMultiframeExpander.layout(List.of(a, b)));
    }

    @Test
    void classicMrWithPerFrameGroups_isNotEnhanced() {
        // 3dFLAIR / HASSAKU 型: 古典 MR に PerFrameFunctionalGroups だけが付いている。SOP クラスで除外する。
        Attributes ds = enhanced(CLASSIC_MR, "1.1", 1, new double[] { 0, 5 }, null, null, null, AXIAL);
        assertNull(EnhancedMultiframeExpander.layout(List.of(ds)));
    }

    @Test
    void mixedWithNonEnhanced_returnsNull() {
        Attributes enh = simple(new double[] { 0, 5 });
        Attributes classic = enhanced(CLASSIC_MR, "2.1", 2, new double[] { 10 }, null, null, null, AXIAL);
        assertNull(EnhancedMultiframeExpander.layout(List.of(enh, classic)));
    }

    @Test
    void unreadablePosition_returnsNull_insteadOfGuessing() {
        assertNull(EnhancedMultiframeExpander.layout(List.of(simple(new double[] { 0, Double.NaN, 10 }))));
    }

    @Test
    void missingOrientation_returnsNull() {
        Attributes ds = enhanced(ENH_CT, "1.1", 1, new double[] { 0, 5 }, null, null, null, null);
        assertNull(EnhancedMultiframeExpander.layout(List.of(ds)));
    }

    @Test
    void temporalPositionIndex_becomesT() {
        Attributes ds = enhanced(ENH_MR, "1.1", 1, new double[] { 0, 0, 5, 5 },
                new int[] { 1, 2, 1, 2 }, null, null, AXIAL);
        SeriesLayout l = EnhancedMultiframeExpander.layout(List.of(ds));
        assertNotNull(l);
        assertEquals(2, l.nZ());
        assertEquals(2, l.nT());
        assertEquals(4, l.cells().size());
    }

    @Test
    void otherDimensionIndex_becomesC_butPositionAndTimeDoNot() {
        // DimensionIndexValues = [InStackPositionNumber, DiffusionBValue]。後者だけが C になる。
        int[] pointers = { Tag.InStackPositionNumber, Tag.DiffusionBValue };
        int[][] dims = { { 1, 1 }, { 1, 2 }, { 2, 1 }, { 2, 2 } };
        Attributes ds = enhanced(ENH_MR, "1.1", 1, new double[] { 0, 0, 5, 5 }, null, dims, pointers, AXIAL);
        SeriesLayout l = EnhancedMultiframeExpander.layout(List.of(ds));
        assertNotNull(l);
        assertEquals(2, l.nZ());
        assertEquals(2, l.nC());
        assertEquals(1, l.nT());
    }

    @Test
    void twoFramesAtTheSameCellWithoutADistinguishingIndex_returnsNull() {
        // 同じ位置に 2 フレームあるが、区別する次元が無い: 捨てずに展開をやめる
        assertNull(EnhancedMultiframeExpander.layout(List.of(simple(new double[] { 0, 0, 5 }))));
    }

    @Test
    void differentOrientations_returnNull() {
        Attributes a = enhanced(ENH_CT, "1.1", 1, new double[] { 0, 5 }, null, null, null, AXIAL);
        Attributes b = enhanced(ENH_CT, "1.2", 2, new double[] { 0, 5 }, null, null, null,
                new double[] { 1, 0, 0, 0, 0, -1 });
        assertNull(EnhancedMultiframeExpander.layout(List.of(a, b)));
    }

    @Test
    void multipleFilesPoolIntoOneStack() {
        Attributes a = enhanced(ENH_CT, "1.1", 1, new double[] { 0, 5 }, null, null, null, AXIAL);
        Attributes b = enhanced(ENH_CT, "1.2", 2, new double[] { 10 }, null, null, null, AXIAL);
        SeriesLayout l = EnhancedMultiframeExpander.layout(List.of(b, a));
        assertNotNull(l);
        assertEquals(3, l.nZ());
        assertEquals(3, l.cells().size());
    }
}
