/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * RTDOSE 書き出しの検証（host API の H23）。
 *
 * <p>主眼:
 * <ol>
 *   <li><b>格納値 × DoseGridScaling が線量 [Gy] に戻る</b>（往復して数字が変わらない）</li>
 *   <li><b>幾何が正しく入る</b>（IPP は先頭フレーム、GridFrameOffsetVector の先頭は 0）</li>
 *   <li><b>準拠していない点が警告として返る</b>（RT Plan が無いことを黙って隠さない）</li>
 *   <li><b>患者・検査は参照シリーズから引き継ぐ</b>（別患者の線量を作らない）</li>
 * </ol>
 *
 * <p>保管庫を使わない（{@code build()} を直接呼ぶ）。保存経路は実機スパイクで確認する。
 */
class RtDoseExportServiceTest {

    private final RtDoseExportService service = new RtDoseExportService(null, null);

    private static final int ROWS = 4;
    private static final int COLS = 3;
    private static final int FRAMES = 2;
    /** 1 格納値 = 0.001 Gy。 */
    private static final double SCALING = 0.001;

    private static Attributes template() {
        Attributes t = new Attributes();
        t.setSpecificCharacterSet("ISO_IR 192");
        t.setString(Tag.PatientID, VR.LO, "PAT-D");
        t.setString(Tag.PatientName, VR.PN, "Phantom^Dosimetry");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.StudyDate, VR.DA, "20260823");
        t.setString(Tag.SeriesNumber, VR.IS, "3");
        t.setString(Tag.FrameOfReferenceUID, VR.UI, "1.2.3.4.100");
        t.setString(Tag.SOPClassUID, VR.UI, UID.PositronEmissionTomographyImageStorage);
        t.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4.5");
        return t;
    }

    /** 格納値 = 連番（0,1,2,…）。線量に直すと 0, 0.001, 0.002 … Gy。 */
    private static byte[] rampPixels() {
        ByteBuffer bb = ByteBuffer.allocate(ROWS * COLS * FRAMES * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < ROWS * COLS * FRAMES; i++) {
            bb.putShort((short) i);
        }
        return bb.array();
    }

    private static RtDoseExportRequest request() {
        return new RtDoseExportRequest(
                "1.2.3.4", "1.2.3.4.9", "Absorbed dose (cycle 1)", null,
                ROWS, COLS,
                new double[] { 1, 0, 0, 0, 1, 0 },
                new double[] { -60, -10, 20 },
                new double[] { 4.42, 4.42 },
                new double[] { 0, 4.42 },
                "GY", "PHYSICAL", "PLAN", "Lu-177 absorbed dose", SCALING, "IMAGE",
                Base64.getEncoder().encodeToString(rampPixels()),
                List.of("1.2.3.4.5"),
                null,
                new RtDoseExportRequest.Producer("dosimetry", "Theranostics Dosimetry", "0.1.0"));
    }

    @Test
    void 格納値と係数が線量に戻る() throws java.io.IOException {
        List<String> warnings = new ArrayList<>();
        Attributes a = service.build(template(), request(), rampPixels(), warnings);

        assertEquals(UID.RTDoseStorage, a.getString(Tag.SOPClassUID));
        assertEquals("RTDOSE", a.getString(Tag.Modality));
        assertEquals("GY", a.getString(Tag.DoseUnits));
        assertEquals("PHYSICAL", a.getString(Tag.DoseType));
        assertEquals(SCALING, a.getDouble(Tag.DoseGridScaling, 0), 1e-12);

        byte[] px = a.getBytes(Tag.PixelData);
        assertEquals(ROWS * COLS * FRAMES * 2, px.length);
        ByteBuffer bb = ByteBuffer.wrap(px).order(ByteOrder.LITTLE_ENDIAN);
        // 格納値 i は i*0.001 Gy。**丸めや取り違えで数字が変わらないこと**を見る。
        for (int i = 0; i < ROWS * COLS * FRAMES; i++) {
            int stored = bb.getShort(i * 2) & 0xFFFF;
            assertEquals(i, stored, "格納値 " + i);
            assertEquals(i * SCALING, stored * a.getDouble(Tag.DoseGridScaling, 0), 1e-12);
        }
    }

    @Test
    void 幾何が入る() {
        Attributes a = service.build(template(), request(), rampPixels(), new ArrayList<>());
        assertEquals(FRAMES, a.getInt(Tag.NumberOfFrames, 0));
        double[] ipp = a.getDoubles(Tag.ImagePositionPatient);
        assertEquals(-60, ipp[0], 1e-9);
        double[] gfov = a.getDoubles(Tag.GridFrameOffsetVector);
        // 先頭は 0（先頭フレームの位置は IPP が表す）。ここが 0 でないと 1 スライスぶんずれる。
        assertEquals(0.0, gfov[0], 1e-12);
        assertEquals(4.42, gfov[1], 1e-9);
        // 空間基準は**参照シリーズから引き継ぐ**（呼び出し側に書かせない）。
        assertEquals("1.2.3.4.100", a.getString(Tag.FrameOfReferenceUID));
        assertEquals(Tag.GridFrameOffsetVector, a.getInt(Tag.FrameIncrementPointer, 0));
    }

    @Test
    void 患者と検査は参照シリーズから引き継ぐ() {
        Attributes a = service.build(template(), request(), rampPixels(), new ArrayList<>());
        assertEquals("PAT-D", a.getString(Tag.PatientID));
        assertEquals("1.2.3.4", a.getString(Tag.StudyInstanceUID));
        // シリーズ / SOP は新規採番（既存を上書きしない）。
        assertNotNull(a.getString(Tag.SeriesInstanceUID));
        assertFalse("1.2.3.4.9".equals(a.getString(Tag.SeriesInstanceUID)));
    }

    @Test
    void RT_Plan_が無いことを黙って隠さない() {
        List<String> warnings = new ArrayList<>();
        Attributes a = service.build(template(), request(), rampPixels(), warnings);
        assertNull(a.getSequence(Tag.ReferencedRTPlanSequence), "無い計画の参照を捏造しない");
        assertTrue(warnings.stream().anyMatch(w -> w.contains("ReferencedRTPlanSequence")),
                "Type 1C を満たしていないことが警告として返る: " + warnings);
    }

    @Test
    void RT_Plan_を渡せば書く() {
        RtDoseExportRequest base = request();
        RtDoseExportRequest req = new RtDoseExportRequest(
                base.studyInstanceUid(), base.seriesInstanceUid(), base.seriesDescription(),
                base.seriesNumber(), base.rows(), base.columns(), base.imageOrientationPatient(),
                base.imagePositionPatient(), base.pixelSpacing(), base.gridFrameOffsetVector(),
                base.doseUnits(), base.doseType(), base.doseSummationType(), base.doseComment(),
                base.doseGridScaling(), base.tissueHeterogeneityCorrection(), base.pixels(),
                base.referencedSopInstanceUids(),
                new RtDoseExportRequest.ReferencedRtPlan(null, "1.2.3.4.777"),
                base.producer());
        List<String> warnings = new ArrayList<>();
        Attributes a = service.build(template(), req, rampPixels(), warnings);
        Sequence seq = a.getSequence(Tag.ReferencedRTPlanSequence);
        assertNotNull(seq);
        assertEquals("1.2.3.4.777", seq.get(0).getString(Tag.ReferencedSOPInstanceUID));
        assertEquals(UID.RTPlanStorage, seq.get(0).getString(Tag.ReferencedSOPClassUID));
        assertTrue(warnings.isEmpty(), "警告は出ない: " + warnings);
    }

    @Test
    void プラグイン出力は出所が残る() {
        Attributes a = service.build(template(), request(), rampPixels(), new ArrayList<>());
        assertTrue(a.getString(Tag.SeriesDescription).startsWith("[Plugin] "));
        Sequence eq = a.getSequence(Tag.ContributingEquipmentSequence);
        assertNotNull(eq);
        assertEquals("0.1.0", eq.get(0).getString(Tag.SoftwareVersions));
    }

    // --- 受け付けない入力 ---

    @Test
    void 先頭オフセットが0でなければ拒否する() {
        RtDoseExportRequest bad = withGfov(request(), new double[] { 4.42, 8.84 });
        assertThrows(IllegalArgumentException.class, () -> service.export(bad));
    }

    @Test
    void 係数が0なら拒否する() {
        RtDoseExportRequest b = request();
        RtDoseExportRequest bad = new RtDoseExportRequest(
                b.studyInstanceUid(), b.seriesInstanceUid(), b.seriesDescription(), b.seriesNumber(),
                b.rows(), b.columns(), b.imageOrientationPatient(), b.imagePositionPatient(),
                b.pixelSpacing(), b.gridFrameOffsetVector(), b.doseUnits(), b.doseType(),
                b.doseSummationType(), b.doseComment(), 0.0, b.tissueHeterogeneityCorrection(),
                b.pixels(), b.referencedSopInstanceUids(), b.referencedRtPlan(), b.producer());
        assertThrows(IllegalArgumentException.class, () -> service.export(bad));
    }

    @Test
    void 列挙値でない線量種別は拒否する() {
        RtDoseExportRequest b = request();
        RtDoseExportRequest bad = new RtDoseExportRequest(
                b.studyInstanceUid(), b.seriesInstanceUid(), b.seriesDescription(), b.seriesNumber(),
                b.rows(), b.columns(), b.imageOrientationPatient(), b.imagePositionPatient(),
                b.pixelSpacing(), b.gridFrameOffsetVector(), b.doseUnits(), "ABSORBED",
                b.doseSummationType(), b.doseComment(), b.doseGridScaling(),
                b.tissueHeterogeneityCorrection(), b.pixels(), b.referencedSopInstanceUids(),
                b.referencedRtPlan(), b.producer());
        assertThrows(IllegalArgumentException.class, () -> service.export(bad));
    }

    private static RtDoseExportRequest withGfov(RtDoseExportRequest b, double[] gfov) {
        return new RtDoseExportRequest(
                b.studyInstanceUid(), b.seriesInstanceUid(), b.seriesDescription(), b.seriesNumber(),
                b.rows(), b.columns(), b.imageOrientationPatient(), b.imagePositionPatient(),
                b.pixelSpacing(), gfov, b.doseUnits(), b.doseType(), b.doseSummationType(),
                b.doseComment(), b.doseGridScaling(), b.tissueHeterogeneityCorrection(), b.pixels(),
                b.referencedSopInstanceUids(), b.referencedRtPlan(), b.producer());
    }
}
