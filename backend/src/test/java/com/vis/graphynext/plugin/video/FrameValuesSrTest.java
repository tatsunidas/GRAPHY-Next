/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.video;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** H48 / H49: フレームごとの値の SR。 */
class FrameValuesSrTest {

    private static Attributes video() {
        Attributes v = new Attributes();
        v.setSpecificCharacterSet("ISO_IR 192");
        v.setString(Tag.PatientID, VR.LO, "K12");
        v.setString(Tag.PatientName, VR.PN, "胎児^K12");
        v.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        v.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.3.4");
        v.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4.5");
        v.setString(Tag.SOPClassUID, VR.UI, UID.UltrasoundMultiFrameImageStorage);
        return v;
    }

    private static final FrameValuesSr.Producer UVS = new FrameValuesSr.Producer("uvs", "UVS", "0.3.0");

    @Test
    void 書いて読むと値が丸められずに戻る() throws Exception {
        // DS（16 文字）に収まらない値・非常に小さい値・負値を混ぜる
        List<Double> cpr = List.of(0.0, 1.0 / 3.0, 1.2345678901234567e-7, 0.5);
        List<Double> mad = List.of(0.19, 0.4999999999999999, 12.75, -0.0);
        FrameValuesSr.Content c = new FrameValuesSr.Content(
                List.of(new FrameValuesSr.Series("CPR", "Colored pixel ratio", "1", cpr),
                        new FrameValuesSr.Series("MAD", "Mean absolute difference", "1", mad)),
                Map.of("scoreSource", "SOURCE_VIDEO"));
        FrameValuesSr.validate(c, 4);
        Attributes sr = FrameValuesSr.build(video(), c, UVS, "9.9.1", "9.9.2", LocalDateTime.of(2026, 9, 26, 12, 0));

        // DICOM ファイルとして往復させる（DS の文字数制限・FD の書き込みを通す）
        Path f = Files.createTempFile("fv-", ".dcm");
        try {
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(sr.createFileMetaInformation(UID.ExplicitVRLittleEndian), sr);
            }
            Attributes back;
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                back = in.readDataset();
            }
            FrameValuesSr.Read r = FrameValuesSr.read(back);
            assertEquals("1.2.3.4.5", r.videoSopInstanceUid());
            assertEquals("uvs", r.producerId());
            assertEquals(Map.of("scoreSource", "SOURCE_VIDEO"), r.params());
            assertEquals(List.of("CPR", "MAD"), r.series().stream().map(FrameValuesSr.Series::key).toList());
            assertEquals(cpr, r.series().get(0).values());
            assertEquals(mad, r.series().get(1).values());
            assertEquals("Colored pixel ratio", r.series().get(0).label());
            // 患者・検査は動画から継承し、出所は本体が入れる
            assertEquals("胎児^K12", back.getString(Tag.PatientName));
            assertEquals("1.2.3", back.getString(Tag.StudyInstanceUID));
            assertTrue(back.getString(Tag.SeriesDescription).startsWith("[Plugin] UVS"));
            assertEquals("UNVERIFIED", back.getString(Tag.VerificationFlag));
            assertEquals("UVS", back.getNestedDataset(Tag.ContributingEquipmentSequence).getString(Tag.ManufacturerModelName));
            for (FrameValuesSr.Series s : r.series()) {
                for (double v : s.values()) assertTrue(FrameValuesSr.ds(v).length() <= 16);
            }
        } finally {
            Files.deleteIfExists(f);
        }
    }

    @Test
    void 長さが動画のフレーム数と違えば拒否する() {
        FrameValuesSr.Content c = new FrameValuesSr.Content(
                List.of(new FrameValuesSr.Series("CPR", "c", "1", List.of(1.0, 2.0))), null);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> FrameValuesSr.validate(c, 3));
        assertTrue(e.getMessage().contains("フレーム数 3"));
    }

    @Test
    void 有限でない値や不正な_key_は拒否する() {
        List<Double> nan = new ArrayList<>(List.of(1.0));
        nan.add(Double.NaN);
        assertThrows(IllegalArgumentException.class, () -> FrameValuesSr.validate(new FrameValuesSr.Content(
                List.of(new FrameValuesSr.Series("CPR", "c", "1", nan)), null), 2));
        assertThrows(IllegalArgumentException.class, () -> FrameValuesSr.validate(new FrameValuesSr.Content(
                List.of(new FrameValuesSr.Series("bad key", "c", "1", List.of(1.0))), null), 1));
        assertThrows(IllegalArgumentException.class, () -> FrameValuesSr.validate(new FrameValuesSr.Content(
                List.of(new FrameValuesSr.Series("A", "c", "1", List.of(1.0)),
                        new FrameValuesSr.Series("A", "c", "1", List.of(1.0))), null), 1));
    }

    @Test
    void 別の形の_SR_は読まない() {
        Attributes other = new Attributes();
        assertNull(FrameValuesSr.read(other));
    }

    @Test
    void 大きさの目安_4628フレーム_2系列() throws Exception {
        List<Double> vals = new ArrayList<>();
        for (int i = 0; i < 4628; i++) vals.add(Math.sin(i) * 0.37);
        FrameValuesSr.Content c = new FrameValuesSr.Content(
                List.of(new FrameValuesSr.Series("CPR", "c", "1", vals), new FrameValuesSr.Series("MAD", "m", "1", vals)), null);
        Attributes sr = FrameValuesSr.build(video(), c, UVS, "9.9.1", "9.9.2", LocalDateTime.now());
        Path f = Files.createTempFile("fv-", ".dcm");
        try {
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(sr.createFileMetaInformation(UID.ExplicitVRLittleEndian), sr);
            }
            long size = Files.size(f);
            System.out.println("[FrameValuesSrTest] 4628 frames x 2 series = " + size + " bytes");
            assertTrue(size < 8_000_000, "SR が大きすぎる: " + size);
        } finally {
            Files.deleteIfExists(f);
        }
    }
}
