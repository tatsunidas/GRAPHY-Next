/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.imageio.codec.Compressor;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertTrue;

/** 圧縮済み DICOM をテスト側で用意する部品（受信側・送信側のコードは使わない）。 */
public final class CompressedFixtures {

    private CompressedFixtures() {
    }

    /** 構造のある CT（64×64、16bit 符号付き、RescaleIntercept あり）。 */
    public static Attributes ct(String sop, String patientId) {
        Attributes a = new Attributes();
        a.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        a.setString(Tag.SOPInstanceUID, VR.UI, sop);
        a.setString(Tag.StudyInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.7001");
        a.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.7002");
        a.setString(Tag.PatientID, VR.LO, patientId);
        a.setString(Tag.PatientName, VR.PN, "FIXTURE^CT");
        a.setString(Tag.Modality, VR.CS, "CT");
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setInt(Tag.Rows, VR.US, 64);
        a.setInt(Tag.Columns, VR.US, 64);
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, 16);
        a.setInt(Tag.HighBit, VR.US, 15);
        a.setInt(Tag.PixelRepresentation, VR.US, 1);
        a.setString(Tag.RescaleIntercept, VR.DS, "0");
        a.setString(Tag.RescaleSlope, VR.DS, "1");
        a.setString(Tag.PixelSpacing, VR.DS, "1", "1");
        ByteBuffer bb = ByteBuffer.allocate(64 * 64 * 2).order(ByteOrder.LITTLE_ENDIAN);
        Random r = new Random(5);
        for (int y = 0; y < 64; y++) {
            for (int x = 0; x < 64; x++) {
                boolean body = (x - 32) * (x - 32) + (y - 32) * (y - 32) < 700;
                bb.putShort((short) ((body ? 40 + y % 9 : -1000) + r.nextInt(7) - 3));
            }
        }
        a.setBytes(Tag.PixelData, VR.OW, bb.array());
        return a;
    }

    public static void write(Path f, Attributes ds, String ts) throws IOException {
        Attributes fmi = ds.createFileMetaInformation(ts);
        try (OutputStream os = Files.newOutputStream(f); DicomOutputStream dos = new DicomOutputStream(os, ts)) {
            dos.writeDataset(fmi, ds);
        }
    }

    /** ds を圧縮した Part-10 ファイルを f に書く。 */
    public static Path compressed(Path f, Attributes ds, String ts) throws IOException {
        Path raw = f.resolveSibling(f.getFileName() + ".raw");
        write(raw, ds, UID.ExplicitVRLittleEndian);
        Attributes src;
        try (DicomInputStream in = new DicomInputStream(raw.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            src = in.readDataset(-1, -1);
        }
        try (Compressor c = new Compressor(src, UID.ExplicitVRLittleEndian)) {
            assertTrue(c.compress(ts), "前提: 圧縮済み入力を作れる " + ts);
            write(f, src, ts);
        }
        Files.deleteIfExists(raw);
        return f;
    }

    /** PixelData のフラグメント（圧縮された画素のバイト列）。 */
    public static List<byte[]> fragments(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            Object v = in.readDataset(-1, -1).getValue(Tag.PixelData);
            assertTrue(v instanceof Fragments, "圧縮された画素のはず");
            List<byte[]> out = new ArrayList<>();
            for (Object o : (Fragments) v) {
                out.add(o instanceof byte[] b ? b : new byte[0]);
            }
            return out;
        }
    }

    public static String tsOf(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            return in.readFileMetaInformation().getString(Tag.TransferSyntaxUID);
        }
    }
}
