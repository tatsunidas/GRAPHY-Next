/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.data.Value;
import org.dcm4che3.io.DicomOutputStream;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 焼き込みのテスト用に、非圧縮／JPEG 圧縮のマルチフレーム DICOM をその場で作る。
 *
 * <p>実データを fixture に置かないのは 2 つの理由から——<b>サイズ</b>（XA 1 ラン 13MB）と、
 * <b>「そのファイルでだけ通る」検査になりやすい</b>こと。JPEG は JDK の ImageIO が
 * <b>書ける</b>ので、読む側（OpenCV ネイティブ）だけを検査対象にできる。
 *
 * <p>🔴 {@code BurnedInAnnotation=YES} を必ず入れる。<b>原本が「焼き込みあり」と言っている</b>
 * ことが、申告の真偽を判定できる前提になる（NO に書き換わったかどうかを見る）。
 */
final class TestDicomFiles {

    static final int COLS = 16;
    static final int ROWS = 16;

    private TestDicomFiles() {
    }

    /** 非圧縮（Explicit VR LE）。全画素 {@code value}。 */
    static Path writeUncompressed(Path file, String studyUid, String seriesUid, String sopUid,
            int frames, int value) throws IOException {
        Attributes ds = header(studyUid, seriesUid, sopUid, frames);
        byte[] px = new byte[ROWS * COLS * frames];
        java.util.Arrays.fill(px, (byte) value);
        ds.setBytes(Tag.PixelData, VR.OB, px);
        return write(file, ds, UID.ExplicitVRLittleEndian);
    }

    /** JPEG Baseline で encapsulate（1 フレーム 1 フラグメント）。 */
    static Path writeJpegBaseline(Path file, String studyUid, String seriesUid, String sopUid,
            int frames, int value) throws IOException {
        Attributes ds = header(studyUid, seriesUid, sopUid, frames);
        byte[] jpeg = jpegFrame(value);
        // 先頭は基本オフセットテーブル（空）。
        Fragments frags = ds.newFragments(Tag.PixelData, VR.OB, frames + 1);
        frags.add(Value.NULL);
        for (int i = 0; i < frames; i++) {
            frags.add(jpeg);
        }
        return write(file, ds, UID.JPEGBaseline8Bit);
    }

    private static Attributes header(String studyUid, String seriesUid, String sopUid, int frames) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, UID.XRayAngiographicImageStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sopUid);
        ds.setString(Tag.StudyInstanceUID, VR.UI, studyUid);
        ds.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
        ds.setString(Tag.PatientID, VR.LO, "P1");
        ds.setString(Tag.PatientName, VR.PN, "TEST^BURNED");
        ds.setString(Tag.Modality, VR.CS, "XA");
        ds.setString(Tag.BurnedInAnnotation, VR.CS, "YES");
        ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        ds.setInt(Tag.Rows, VR.US, ROWS);
        ds.setInt(Tag.Columns, VR.US, COLS);
        ds.setInt(Tag.BitsAllocated, VR.US, 8);
        ds.setInt(Tag.BitsStored, VR.US, 8);
        ds.setInt(Tag.HighBit, VR.US, 7);
        ds.setInt(Tag.PixelRepresentation, VR.US, 0);
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        ds.setInt(Tag.NumberOfFrames, VR.IS, frames);
        return ds;
    }

    private static Path write(Path file, Attributes ds, String tsuid) throws IOException {
        Attributes fmi = ds.createFileMetaInformation(tsuid);
        try (OutputStream os = Files.newOutputStream(file);
                DicomOutputStream dos = new DicomOutputStream(os, tsuid)) {
            dos.writeDataset(fmi, ds);
        }
        return file;
    }

    /**
     * 一様な濃度の JPEG を 1 枚。
     *
     * <p>⚠ <b>一様にするのは意図的。</b> JPEG Baseline は非可逆なので、階調があると伸長後の値が
     * 元と一致しない。平坦な絵なら DCT の直流成分だけになり、値がほぼそのまま戻る
     * ——「塗られていない画素は元のまま」を数値で確かめられるようにするため。
     */
    private static byte[] jpegFrame(int value) throws IOException {
        BufferedImage img = new BufferedImage(COLS, ROWS, BufferedImage.TYPE_BYTE_GRAY);
        for (int y = 0; y < ROWS; y++) {
            for (int x = 0; x < COLS; x++) {
                img.getRaster().setSample(x, y, 0, value);
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (!javax.imageio.ImageIO.write(img, "jpeg", out)) {
            throw new IOException("この JVM は JPEG を書けません");
        }
        return out.toByteArray();
    }
}
