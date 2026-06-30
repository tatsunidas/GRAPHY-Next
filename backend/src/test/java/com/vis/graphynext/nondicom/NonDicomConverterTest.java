/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nondicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;

import java.awt.Color;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/** PDF / 画像 → DICOM 化（ファイル非依存）の検証。 */
class NonDicomConverterTest {

    private static NonDicomConverter.Ctx ctx(String modality, int instNo) {
        return new NonDicomConverter.Ctx(
                "PID-1", "山田^太郎", "19800101", "M",
                "1.2.3", "20260630", "120000", "Imported", "ACC1",
                "1.2.3.1", 1, "Imported docs", modality, instNo);
    }

    @Test
    void pdf_buildsEncapsulatedPdf() throws Exception {
        byte[] pdf = "%PDF-1.4 dummy".getBytes();
        Attributes a = NonDicomConverter.encapsulatedPdf(ctx("DOC", 1), "report", pdf);
        assertEquals(UID.EncapsulatedPDFStorage, a.getString(Tag.SOPClassUID));
        assertEquals("application/pdf", a.getString(Tag.MIMETypeOfEncapsulatedDocument));
        assertEquals("DOC", a.getString(Tag.Modality));
        assertEquals("report", a.getString(Tag.DocumentTitle));
        assertArrayEquals(pdf, a.getBytes(Tag.EncapsulatedDocument));
        assertNotNull(a.getString(Tag.SOPInstanceUID));
        // 文字コードと日本語名
        assertEquals("ISO_IR 192", a.getString(Tag.SpecificCharacterSet));
        assertEquals("山田^太郎", a.getString(Tag.PatientName));
    }

    @Test
    void colorImage_buildsRgbSecondaryCapture() throws Exception {
        BufferedImage img = new BufferedImage(4, 3, BufferedImage.TYPE_INT_RGB);
        img.setRGB(0, 0, new Color(10, 20, 30).getRGB());
        Attributes a = NonDicomConverter.secondaryCapture(ctx("OT", 1), img);
        assertEquals(UID.SecondaryCaptureImageStorage, a.getString(Tag.SOPClassUID));
        assertEquals(3, a.getInt(Tag.Rows, 0));
        assertEquals(4, a.getInt(Tag.Columns, 0));
        assertEquals(3, a.getInt(Tag.SamplesPerPixel, 0));
        assertEquals("RGB", a.getString(Tag.PhotometricInterpretation));
        assertEquals(8, a.getInt(Tag.BitsAllocated, 0));
        byte[] px = a.getBytes(Tag.PixelData);
        assertEquals(4 * 3 * 3, px.length);
        // 先頭ピクセル R,G,B
        assertEquals(10, px[0] & 0xff);
        assertEquals(20, px[1] & 0xff);
        assertEquals(30, px[2] & 0xff);
    }

    @Test
    void grayImage_buildsMonochrome2() throws Exception {
        BufferedImage img = new BufferedImage(2, 2, BufferedImage.TYPE_BYTE_GRAY);
        Attributes a = NonDicomConverter.secondaryCapture(ctx("OT", 2), img);
        assertEquals(1, a.getInt(Tag.SamplesPerPixel, 0));
        assertEquals("MONOCHROME2", a.getString(Tag.PhotometricInterpretation));
        assertEquals(2 * 2, a.getBytes(Tag.PixelData).length);
    }

    @Test
    void pdf_roundTripsAsValidPart10() throws Exception {
        byte[] pdf = {1, 2, 3}; // 奇数長 → OB の偶数パディングを確認
        Attributes a = NonDicomConverter.encapsulatedPdf(ctx("DOC", 1), "report", pdf);
        Path tmp = Files.createTempFile("nondicom-test-", ".dcm");
        try {
            Attributes fmi = a.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(fmi, a);
            }
            try (DicomInputStream in = new DicomInputStream(tmp.toFile())) {
                Attributes read = in.readDatasetUntilPixelData();
                assertEquals(UID.EncapsulatedPDFStorage, read.getString(Tag.SOPClassUID));
                assertEquals("山田^太郎", read.getString(Tag.PatientName)); // UTF-8 ラウンドトリップ
                byte[] doc = read.getBytes(Tag.EncapsulatedDocument);
                assertNotNull(doc);
                assertEquals(1, doc[0] & 0xff);
                assertEquals(2, doc[1] & 0xff);
                assertEquals(3, doc[2] & 0xff);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }
}
