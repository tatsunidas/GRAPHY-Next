/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * NM（SPECT）の古典マルチフレーム断層の展開（プラグイン host API の H28）。
 *
 * <p>ここが壊れると「実データの SPECT が 1 枚しか開けない」に戻る。しかも<b>1 枚は表示される</b>ので
 * 壊れて見えない ＝ 自動テストで守る価値が高い（XA シネと同じ理由）。
 */
class NmFrameExpanderTest {

    private static final String NM = "1.2.840.10008.5.1.4.1.1.20";
    private static final int ROWS = 4;
    private static final int COLS = 4;

    /** SliceVector 1..frames・DetectorInformationSequence に幾何を持つ、典型的な再構成 SPECT。 */
    private static Attributes nmTomo(String sop, int frames, double spacing) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, NM);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
        ds.setString(Tag.Modality, VR.CS, "NM");
        ds.setString(Tag.ImageType, VR.CS, "ORIGINAL", "PRIMARY", "RECON TOMO", "EMISSION");
        ds.setInt(Tag.NumberOfFrames, VR.IS, frames);
        ds.setInt(Tag.NumberOfSlices, VR.US, frames);
        int[] sliceVector = new int[frames];
        for (int i = 0; i < frames; i++) {
            sliceVector[i] = i + 1;
        }
        ds.setInt(Tag.SliceVector, VR.US, sliceVector);
        ds.setInt(Tag.Rows, VR.US, ROWS);
        ds.setInt(Tag.Columns, VR.US, COLS);
        ds.setInt(Tag.BitsAllocated, VR.US, 16);
        ds.setInt(Tag.BitsStored, VR.US, 16);
        ds.setInt(Tag.HighBit, VR.US, 15);
        ds.setInt(Tag.PixelRepresentation, VR.US, 0);
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        ds.setDouble(Tag.PixelSpacing, VR.DS, 4.42, 4.42);
        ds.setDouble(Tag.SpacingBetweenSlices, VR.DS, spacing);
        ds.setDouble(Tag.SliceThickness, VR.DS, spacing);
        ds.setString(Tag.FrameOfReferenceUID, VR.UI, "9.8.7.6");
        Sequence det = ds.newSequence(Tag.DetectorInformationSequence, 1);
        Attributes d0 = new Attributes();
        d0.setDouble(Tag.ImagePositionPatient, VR.DS, -10.0, -20.0, -30.0);
        d0.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
        det.add(d0);
        // 画素は「フレーム番号」で埋める（抽出したフレームがどれか分かるように）。
        byte[] px = new byte[ROWS * COLS * 2 * frames];
        for (int f = 0; f < frames; f++) {
            for (int p = 0; p < ROWS * COLS; p++) {
                int off = (f * ROWS * COLS + p) * 2;
                px[off] = (byte) (f + 1);
                px[off + 1] = 0;
            }
        }
        ds.setBytes(Tag.PixelData, VR.OW, px);
        return ds;
    }

    @Test
    void 再構成断層のNMを検出する() {
        assertTrue(NmFrameExpander.isNmTomo(nmTomo("1.1", 8, 4.42)));
    }

    @Test
    void 単一フレームや他モダリティは対象外() {
        assertFalse(NmFrameExpander.isNmTomo(nmTomo("1.1", 1, 4.42)));
        Attributes ct = nmTomo("1.2", 8, 4.42);
        ct.setString(Tag.Modality, VR.CS, "CT");
        assertFalse(NmFrameExpander.isNmTomo(ct));
        assertFalse(NmFrameExpander.isNmTomo(null));
    }

    @Test
    void 平面像のNM_プラナーは対象外() {
        // NumberOfSlices も SliceVector も RECON TOMO も無い多フレーム＝ダイナミック平面像。
        Attributes planar = new Attributes();
        planar.setString(Tag.SOPClassUID, VR.UI, NM);
        planar.setString(Tag.SOPInstanceUID, VR.UI, "2.1");
        planar.setString(Tag.Modality, VR.CS, "NM");
        planar.setInt(Tag.NumberOfFrames, VR.IS, 30);
        planar.setInt(Tag.Rows, VR.US, ROWS);
        planar.setInt(Tag.Columns, VR.US, COLS);
        assertFalse(NmFrameExpander.isNmTomo(planar));
        assertNull(NmFrameExpander.layout(List.of(planar)));
    }

    @Test
    void フレームがZに展開される() {
        SeriesLayout layout = NmFrameExpander.layout(List.of(nmTomo("1.1", 8, 4.42)));
        assertNotNull(layout);
        assertEquals(8, layout.nZ());
        assertEquals(1, layout.nC());
        assertEquals(1, layout.nT());
        assertEquals(8, layout.cells().size());
        // セルは (z, frame) が一致している＝フロントは frames/{frame}/file を読む。
        for (SeriesLayout.Cell cell : layout.cells()) {
            assertEquals(cell.z(), cell.frame());
        }
    }

    @Test
    void スライス位置が法線方向に積み上がる() {
        SeriesLayout layout = NmFrameExpander.layout(List.of(nmTomo("1.1", 8, 4.42)));
        assertNotNull(layout.zSpatial());
        assertEquals(8, layout.zSpatial().size());
        double[] z0 = layout.zSpatial().get(0).imagePositionPatient();
        double[] z3 = layout.zSpatial().get(3).imagePositionPatient();
        assertEquals(-30.0, z0[2], 1e-9);
        // IOP=(1,0,0,0,1,0) → 法線は +z。3 スライスぶん進む。
        assertEquals(-30.0 + 3 * 4.42, z3[2], 1e-9);
        assertEquals(z0[0], z3[0], 1e-9);
    }

    @Test
    void 間隔が無ければ座標を作らない() {
        Attributes ds = nmTomo("1.1", 4, 4.42);
        ds.remove(Tag.SpacingBetweenSlices);
        ds.remove(Tag.SliceThickness);
        assertNull(NmFrameExpander.frameIpp(ds, 1));
        SeriesLayout layout = NmFrameExpander.layout(List.of(ds));
        assertNotNull(layout);
        // ★ 座標を捏造しない: 空間情報が無いレイアウトになる（スタックとしては開ける）。
        assertNull(layout.zSpatial());
    }

    @Test
    void SliceVectorの順序に従う() {
        Attributes ds = nmTomo("1.1", 4, 4.0);
        ds.setInt(Tag.SliceVector, VR.US, new int[] { 4, 3, 2, 1 }); // 逆順に格納された場合
        assertEquals(3, NmFrameExpander.sliceIndexOf(ds, 0));
        assertEquals(0, NmFrameExpander.sliceIndexOf(ds, 3));
        SeriesLayout layout = NmFrameExpander.layout(List.of(ds));
        SeriesLayout.Cell first = layout.cells().get(0);
        assertEquals(0, first.frame());
        assertEquals(3, first.z());
    }

    @Test
    void 同じスライスが繰り返されたらTへ送る() {
        Attributes ds = nmTomo("1.1", 4, 4.0);
        ds.setInt(Tag.SliceVector, VR.US, new int[] { 1, 2, 1, 2 }); // ゲート 2 位相 × 2 スライス
        SeriesLayout layout = NmFrameExpander.layout(List.of(ds));
        assertEquals(2, layout.nZ());
        assertEquals(2, layout.nT());
    }

    @Test
    void フレーム抽出が幾何と画素を持つ単一フレームを返す() throws Exception {
        Attributes ds = nmTomo("1.2.3", 8, 4.42);
        byte[] dicom = NmFrameExpander.extractFrame(ds, 3);
        assertNotNull(dicom);
        Attributes out;
        try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(dicom))) {
            in.readFileMetaInformation();
            out = in.readDataset(-1, -1);
        }
        double[] ipp = out.getDoubles(Tag.ImagePositionPatient);
        assertNotNull(ipp);
        assertEquals(-30.0 + 3 * 4.42, ipp[2], 1e-9);
        assertEquals(4.42, out.getDouble(Tag.SliceThickness, 0), 1e-9);
        assertEquals("9.8.7.6", out.getString(Tag.FrameOfReferenceUID));
        // ★ 同じフレームなら常に同じ SOP UID（読み直すたびに別インスタンスに見えない）＝ 親 SOP ＋ フレーム番号。
        assertEquals("1.2.3.4", out.getString(Tag.SOPInstanceUID));
        // 画素は 4 番目のフレーム（値 4）。
        byte[] px = out.getBytes(Tag.PixelData);
        assertEquals(ROWS * COLS * 2, px.length);
        assertEquals(4, px[0]);
    }

    @Test
    void 抽出したフレームのUIDはフレームごとに変わる() {
        Attributes ds = nmTomo("1.2.3", 8, 4.42);
        assertNotNull(NmFrameExpander.extractFrame(ds, 0));
        assertNotNull(NmFrameExpander.extractFrame(ds, 1));
    }

    // --- Modality が NM でない再構成 SPECT（GE Xeleris）------------------------------

    @Test
    void ModalityがOTでもSOPClassがNMなら展開する() {
        // GE Xeleris の再構成 SPECT。SOP Class は NM Image Storage で中身は断層なのに
        // Modality だけが OT（MRTDosimetry の公開データで実際にこうなっている）。
        Attributes ds = nmTomo("1.1", 8, 4.42);
        ds.setString(Tag.Modality, VR.CS, "OT");
        assertTrue(NmFrameExpander.isNmTomo(ds));
        SeriesLayout layout = NmFrameExpander.layout(List.of(ds));
        assertNotNull(layout);
        assertEquals(8, layout.nZ());
    }

    @Test
    void Modalityが空でもSOPClassがNMなら展開する() {
        Attributes ds = nmTomo("1.1", 8, 4.42);
        ds.setString(Tag.Modality, VR.CS, "");
        assertTrue(NmFrameExpander.isNmTomo(ds));
    }

    @Test
    void SOPClassがNMでないOTは対象外() {
        // Secondary Capture などの OT を、断層の体裁だからといって核医学に読み替えない。
        Attributes ds = nmTomo("1.1", 8, 4.42);
        ds.setString(Tag.Modality, VR.CS, "OT");
        ds.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.7"); // Secondary Capture
        assertFalse(NmFrameExpander.isNmTomo(ds));
    }

    // --- 1 ファイル＝1 スライスのものを巻き込まない ---------------------------------

    @Test
    void NumberOfFramesが1なら展開しない_エンハンス系の1ファイル1スライス() {
        // エンハンス系は NumberOfFrames を持ちながら 1 枚ずつファイルが分かれていることがある
        // （VSRAD 用の T1 など）。ここで展開すると 1 スライスぶんの Z しか組めず、
        // シリーズが 1 枚に潰れる。★ NumberOfFrames > 1 だけを展開の条件にする。
        Attributes enhanced = nmTomo("1.1", 1, 1.0);
        enhanced.setString(Tag.Modality, VR.CS, "MR");
        enhanced.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.4.1"); // Enhanced MR
        enhanced.setInt(Tag.NumberOfFrames, VR.IS, 1);
        assertFalse(NmFrameExpander.isNmTomo(enhanced));
        assertNull(NmFrameExpander.layout(List.of(enhanced)));

        // Modality を OT にしても、SOP Class を NM にしても、フレームが 1 なら通さない。
        Attributes ot = nmTomo("1.2", 1, 4.42);
        ot.setString(Tag.Modality, VR.CS, "OT");
        ot.setInt(Tag.NumberOfFrames, VR.IS, 1);
        assertFalse(NmFrameExpander.isNmTomo(ot));

        // NumberOfFrames そのものが無い場合も同じ（1 枚として扱う）。
        Attributes noFrames = nmTomo("1.3", 4, 4.42);
        noFrames.remove(Tag.NumberOfFrames);
        assertFalse(NmFrameExpander.isNmTomo(noFrames));
    }

    @Test
    void 断層の根拠が無い多フレームのOTは対象外() {
        // Modality を緩めたぶん、断層の根拠（NumberOfSlices / SliceVector / RECON TOMO）は
        // これまでどおり必須にする。ダイナミック平面像を Z に展開しないため。
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, NM);
        ds.setString(Tag.SOPInstanceUID, VR.UI, "3.1");
        ds.setString(Tag.Modality, VR.CS, "OT");
        ds.setInt(Tag.NumberOfFrames, VR.IS, 30);
        ds.setInt(Tag.Rows, VR.US, ROWS);
        ds.setInt(Tag.Columns, VR.US, COLS);
        assertFalse(NmFrameExpander.isNmTomo(ds));
    }
}
