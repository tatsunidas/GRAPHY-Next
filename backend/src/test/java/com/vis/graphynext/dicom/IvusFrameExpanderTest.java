/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 血管内画像（IVUS / OCT）のレイアウト展開（{@code fw/angio-design.md} §12 / A8）。
 *
 * <p>ここが無いと <b>pullback を取り込んでも先頭フレームしか出ない</b>。しかも
 * <b>1 枚は表示される</b>ので壊れているように見えない ＝ 自動テストで守る価値が高い
 * （XA でまったく同じ理由でテストを置いている）。
 */
class IvusFrameExpanderTest {

    private static final String US_MULTI = "1.2.840.10008.5.1.4.1.1.3.1";
    private static final String IVOCT_PRESENT = "1.2.840.10008.5.1.4.1.1.14.1";
    private static final String IVOCT_PROCESS = "1.2.840.10008.5.1.4.1.1.14.2";
    private static final String XA = "1.2.840.10008.5.1.4.1.1.12.1";

    private static Attributes pullback(String sopClass, String modality, String sop, int instanceNumber, int frames) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, sopClass);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
        if (modality != null) {
            ds.setString(Tag.Modality, VR.CS, modality);
        }
        ds.setInt(Tag.InstanceNumber, VR.IS, instanceNumber);
        ds.setInt(Tag.NumberOfFrames, VR.IS, frames);
        ds.setInt(Tag.Rows, VR.US, 512);
        ds.setInt(Tag.Columns, VR.US, 512);
        ds.setInt(Tag.BitsAllocated, VR.US, 8);
        return ds;
    }

    @Test
    void ivusPullbackIsExpandedOnTheFrameAxis() {
        SeriesLayout layout = IvusFrameExpander.layout(
                List.of(pullback(US_MULTI, "IVUS", "1.1", 1, 270)));
        assertNotNull(layout, "IVUS の pullback が展開されていない（先頭フレームしか出ない状態）");
        assertEquals(1, layout.nZ(), "1 プルバック = Z 1 枚");
        assertEquals(270, layout.nT(), "フレームは T 軸へ");
        assertEquals("t", layout.axes().stackAxis(), "スタックはフレーム軸（送るたびに setStack しない）");
        assertEquals(270, layout.cells().size());
    }

    @Test
    void ivoctIsExpandedRegardlessOfModality() {
        // OCT の SOP クラスは血管内専用なので、Modality が空でも対象にする。
        for (String sopClass : List.of(IVOCT_PRESENT, IVOCT_PROCESS)) {
            SeriesLayout layout = IvusFrameExpander.layout(
                    List.of(pullback(sopClass, null, "1.1", 1, 375)));
            assertNotNull(layout, sopClass + " が展開されていない");
            assertEquals(375, layout.nT(), sopClass);
        }
    }

    @Test
    void echoIsNotHijacked() {
        // 🔴 US Multi-frame は**心エコーでも使われる**。SOP クラスだけで判定すると
        //    通常の超音波シネまでこの経路に入り、軸の意味（プルバック）が嘘になる。
        assertNull(IvusFrameExpander.layout(List.of(pullback(US_MULTI, "US", "1.1", 1, 60))),
                "心エコー（Modality=US）を血管内として扱ってはいけない");
        assertNull(IvusFrameExpander.layout(List.of(pullback(US_MULTI, null, "1.1", 1, 60))),
                "Modality が無い US マルチフレームも対象外");
    }

    @Test
    void modalityMatchIsCaseInsensitiveAndTrimmed() {
        // 実データのモダリティは前後に空白が入ることがある（VR=CS の埋め）。
        assertTrue(IvusFrameExpander.isIntravascular(pullback(US_MULTI, "ivus ", "1.1", 1, 10)));
        assertTrue(IvusFrameExpander.isIntravascular(pullback(US_MULTI, "IVUS", "1.1", 1, 10)));
    }

    @Test
    void nonIntravascularReturnsNull() {
        assertNull(IvusFrameExpander.layout(List.of(pullback(XA, "XA", "1.1", 1, 96))),
                "XA は XaFrameExpander の担当");
        assertNull(IvusFrameExpander.layout(List.of()));
        assertNull(IvusFrameExpander.layout(null));
        assertFalse(IvusFrameExpander.isIntravascular(null));
    }

    @Test
    void singleFramePullbackStillUsesTheFrameAxis() {
        // フレーム数では判定しない（XA と同じ理由）。1 枚の収集だけ別の見え方になるのを防ぐ。
        SeriesLayout layout = IvusFrameExpander.layout(
                List.of(pullback(US_MULTI, "IVUS", "1.1", 1, 1)));
        assertNotNull(layout);
        assertEquals(1, layout.nT());
        assertEquals("t", layout.axes().stackAxis());
    }

    @Test
    void shorterPullbackStopsOnItsLastFrame() {
        // 長さの違う 2 本。短い方はブランクではなく最終フレームで止める（再生中の黒画面を避ける）。
        SeriesLayout layout = IvusFrameExpander.layout(List.of(
                pullback(US_MULTI, "IVUS", "1.1", 1, 3),
                pullback(US_MULTI, "IVUS", "1.2", 2, 5)));
        assertNotNull(layout);
        assertEquals(2, layout.nZ());
        assertEquals(5, layout.nT());
        SeriesLayout.Cell last = layout.cells().stream()
                .filter(c -> c.z() == 0 && c.t() == 4)
                .findFirst().orElseThrow();
        assertEquals(2, last.frame(), "短いプルバックは最終フレーム（0 origin で 2）で止まる");
    }

    @Test
    void mixedSeriesKeepsOnlyIntravascular() {
        SeriesLayout layout = IvusFrameExpander.layout(List.of(
                pullback(XA, "XA", "1.9", 0, 96),
                pullback(US_MULTI, "IVUS", "1.1", 1, 40)));
        assertNotNull(layout);
        assertEquals(1, layout.nZ(), "血管内のみを採る（混ぜると軸の意味が壊れる）");
        assertEquals(40, layout.nT());
    }

    @Test
    void noGeometryIsAttached() {
        // 患者座標での位置はアンギオ側との対応づけ（§12.2）で初めて決まる。ここで付けると
        // シリーズ Sync・参照線・MPR が誤って有効化される。
        SeriesLayout layout = IvusFrameExpander.layout(
                List.of(pullback(US_MULTI, "IVUS", "1.1", 1, 100)));
        assertNotNull(layout);
        assertNull(layout.imageOrientationPatient(), "IOP を付けない");
        assertNull(layout.frameOfReferenceUID(), "FrameOfReference を付けない");
        assertNull(layout.zSpatial(), "Z の空間情報を付けない");
    }

    @Test
    void assemblerRoutesIntravascularToTheFrameAxis() {
        // 🔑 展開器を書いても **Assembler から呼ばれていなければ意味が無い**（classic 経路は
        //    NumberOfFrames を見ないので、1 枚しか出ない状態に戻る）。ここを繋いで固定する。
        SeriesLayout layout = SeriesLayoutAssembler.fromAttributes(
                List.of(pullback(US_MULTI, "IVUS", "1.1", 1, 128)));
        assertEquals(128, layout.nT(), "Assembler が IvusFrameExpander へ委譲していない");
        assertEquals("t", layout.axes().stackAxis());
    }

    @Test
    void ivoctIsAcceptedByTheStorageScp() {
        // 🔴 許可リストに無いと C-STORE で presentation context が提示されず**受信できない**。
        //    キーワードの綴りが違っても警告ログが出るだけで静かにスキップされるので、
        //    UID で存在を確かめる。
        List<TransferCapability> caps = StorageSopClasses.scpCapabilities("/dicom/storage-sop-classes.properties");
        List<String> uids = caps.stream().map(TransferCapability::getSopClass).toList();
        assertTrue(uids.contains(IVOCT_PRESENT), "IVOCT (For Presentation) が SCP の許可リストに無い");
        assertTrue(uids.contains(IVOCT_PROCESS), "IVOCT (For Processing) が SCP の許可リストに無い");
        assertTrue(uids.contains(US_MULTI), "US Multi-frame（IVUS の実体）が許可リストに無い");
    }
}
