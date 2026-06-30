/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nondicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.UIDUtils;

import java.awt.image.BufferedImage;
import java.awt.image.Raster;

/**
 * 非 DICOM ファイル（PDF / 一般画像）を DICOM {@link Attributes} へ変換する（DICOM 化）。
 *
 * <p>PDF → Encapsulated PDF Storage、画像 → Secondary Capture Image Storage。
 * 患者/スタディ/シリーズの紐付けは {@link Ctx} で与える。SOPInstanceUID は変換ごとに採番。
 * 文字コードは ISO_IR 192（UTF-8）で日本語の患者名等に対応。生成は純粋関数（I/O を持たずテスト可能）。
 */
public final class NonDicomConverter {

    private NonDicomConverter() {}

    /** 紐付けコンテキスト（患者/スタディ/シリーズ＋採番）。 */
    public record Ctx(
            String patientId, String patientName, String patientBirthDate, String patientSex,
            String studyInstanceUid, String studyDate, String studyTime,
            String studyDescription, String accessionNumber,
            String seriesInstanceUid, int seriesNumber, String seriesDescription,
            String modality, int instanceNumber) {}

    /** 共通属性（患者/スタディ/シリーズ/インスタンス＋文字コード）。 */
    static Attributes common(Ctx c) {
        Attributes a = new Attributes();
        a.setSpecificCharacterSet("ISO_IR 192");
        // 患者
        a.setString(Tag.PatientID, VR.LO, nz(c.patientId()));
        a.setString(Tag.PatientName, VR.PN, nz(c.patientName()));
        if (notBlank(c.patientBirthDate())) {
            a.setString(Tag.PatientBirthDate, VR.DA, c.patientBirthDate());
        }
        if (notBlank(c.patientSex())) {
            a.setString(Tag.PatientSex, VR.CS, c.patientSex());
        }
        // スタディ
        a.setString(Tag.StudyInstanceUID, VR.UI, c.studyInstanceUid());
        a.setString(Tag.StudyDate, VR.DA, nz(c.studyDate()));
        a.setString(Tag.StudyTime, VR.TM, nz(c.studyTime()));
        a.setString(Tag.StudyID, VR.SH, "1");
        a.setString(Tag.AccessionNumber, VR.SH, nz(c.accessionNumber()));
        a.setString(Tag.StudyDescription, VR.LO, nz(c.studyDescription()));
        a.setString(Tag.ReferringPhysicianName, VR.PN, "");
        // シリーズ
        a.setString(Tag.SeriesInstanceUID, VR.UI, c.seriesInstanceUid());
        a.setInt(Tag.SeriesNumber, VR.IS, c.seriesNumber());
        a.setString(Tag.SeriesDescription, VR.LO, nz(c.seriesDescription()));
        a.setString(Tag.Modality, VR.CS, nz(c.modality()));
        // インスタンス
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setInt(Tag.InstanceNumber, VR.IS, c.instanceNumber());
        a.setString(Tag.ContentDate, VR.DA, nz(c.studyDate()));
        a.setString(Tag.ContentTime, VR.TM, nz(c.studyTime()));
        a.setString(Tag.ConversionType, VR.CS, "WSD"); // Workstation
        return a;
    }

    /** PDF → Encapsulated PDF Storage。 */
    public static Attributes encapsulatedPdf(Ctx c, String documentTitle, byte[] pdf) {
        Attributes a = common(c);
        a.setString(Tag.SOPClassUID, VR.UI, UID.EncapsulatedPDFStorage);
        a.setString(Tag.MIMETypeOfEncapsulatedDocument, VR.LO, "application/pdf");
        a.setString(Tag.DocumentTitle, VR.ST, nz(documentTitle));
        a.setBytes(Tag.EncapsulatedDocument, VR.OB, pdf);
        return a;
    }

    /** 一般画像 → Secondary Capture Image Storage（非圧縮 RGB / MONOCHROME2）。 */
    public static Attributes secondaryCapture(Ctx c, BufferedImage img) {
        int w = img.getWidth();
        int h = img.getHeight();
        Attributes a = common(c);
        a.setString(Tag.SOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
        a.setInt(Tag.Rows, VR.US, h);
        a.setInt(Tag.Columns, VR.US, w);
        a.setInt(Tag.BitsAllocated, VR.US, 8);
        a.setInt(Tag.BitsStored, VR.US, 8);
        a.setInt(Tag.HighBit, VR.US, 7);
        a.setInt(Tag.PixelRepresentation, VR.US, 0);

        boolean gray = img.getType() == BufferedImage.TYPE_BYTE_GRAY;
        if (gray) {
            byte[] px = new byte[w * h];
            Raster r = img.getRaster();
            int[] s = new int[1];
            int i = 0;
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    r.getPixel(x, y, s);
                    px[i++] = (byte) s[0];
                }
            }
            a.setInt(Tag.SamplesPerPixel, VR.US, 1);
            a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
            a.setBytes(Tag.PixelData, VR.OB, px);
        } else {
            byte[] px = new byte[w * h * 3];
            int i = 0;
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int rgb = img.getRGB(x, y);
                    px[i++] = (byte) ((rgb >> 16) & 0xff);
                    px[i++] = (byte) ((rgb >> 8) & 0xff);
                    px[i++] = (byte) (rgb & 0xff);
                }
            }
            a.setInt(Tag.SamplesPerPixel, VR.US, 3);
            a.setString(Tag.PhotometricInterpretation, VR.CS, "RGB");
            a.setInt(Tag.PlanarConfiguration, VR.US, 0);
            a.setBytes(Tag.PixelData, VR.OB, px);
        }
        return a;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
