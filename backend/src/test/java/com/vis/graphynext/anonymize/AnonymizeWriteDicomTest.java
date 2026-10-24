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
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 匿名化の書き出し（{@link AnonymizeService#writeDicom}）が、転送構文によらず読み直せるファイルを書くこと。
 *
 * <p>受信時の匿名化と同じ経路で確かめる: 元ファイルを {@code IncludeBulkData.URI}（画素は元ファイルへの参照）で読み、
 * 元ファイルが残っている間に書き、書いたものを読み直して転送構文・患者 ID・画素のバイト列を元と比べる。
 * 実機で Implicit VR の C-STORE が全件断られた不具合（Part 10 のファイルメタ情報は Explicit VR で書く）の回帰。
 */
class AnonymizeWriteDicomTest {

    @TempDir
    Path dir;

    /** 非圧縮の素材を、与えた転送構文で書く。画素は 16x16・8bit の傾斜（全画素が同じ値だと並びの取り違えに気づけない）。 */
    private Path writeRaw(String name, String tsuid) throws IOException {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4.5." + name.hashCode());
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.4");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.3.4.5");
        ds.setString(Tag.PatientID, VR.LO, "ORIG-ID");
        ds.setString(Tag.PatientName, VR.PN, "ORIG^NAME");
        ds.setString(Tag.Modality, VR.CS, "CT");
        ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        ds.setInt(Tag.Rows, VR.US, 16);
        ds.setInt(Tag.Columns, VR.US, 16);
        ds.setInt(Tag.BitsAllocated, VR.US, 8);
        ds.setInt(Tag.BitsStored, VR.US, 8);
        ds.setInt(Tag.HighBit, VR.US, 7);
        ds.setInt(Tag.PixelRepresentation, VR.US, 0);
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        byte[] px = new byte[16 * 16];
        for (int i = 0; i < px.length; i++) {
            px[i] = (byte) i;
        }
        ds.setBytes(Tag.PixelData, VR.OB, px);
        return writeSource(dir.resolve(name), ds, tsuid);
    }

    /** 受信で一時ファイルを作るのと同じ書き方（Explicit で開き、ファイルメタ情報の後でデータセットの転送構文に切り替わる）。 */
    private static Path writeSource(Path file, Attributes ds, String tsuid) throws IOException {
        Attributes fmi = ds.createFileMetaInformation(tsuid);
        try (DicomOutputStream out = new DicomOutputStream(file.toFile())) {
            out.writeDataset(fmi, ds);
        }
        return file;
    }

    /** ReceiveAnonymizer.process と同じ読み方・書き方で、元ファイルから匿名化済みのファイルを作る。 */
    private Path roundTrip(Path src) throws IOException {
        Attributes ds;
        String tsuid;
        try (DicomInputStream in = new DicomInputStream(src.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.URI);
            in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
            tsuid = in.getTransferSyntax();
        }
        ds.setString(Tag.PatientID, VR.LO, "ANON-1");
        Path out = dir.resolve(src.getFileName() + ".anon");
        try (OutputStream os = Files.newOutputStream(out)) {
            AnonymizeService.writeDicom(ds, tsuid, os);
        }
        return out;
    }

    private static Attributes read(Path f, String[] tsuidOut) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.YES);
            Attributes fmi = in.readFileMetaInformation();
            tsuidOut[0] = fmi.getString(Tag.TransferSyntaxUID);
            return in.readDataset(-1, -1);
        }
    }

    private void assertRawRoundTrip(String tsuid) throws IOException {
        Path src = writeRaw("raw-" + tsuid, tsuid);
        String[] ts = new String[1];
        byte[] before = read(src, ts).getSafeBytes(Tag.PixelData);

        Path out = roundTrip(src);

        Attributes after = read(out, ts);
        assertEquals(tsuid, ts[0], "転送構文は変えない");
        assertEquals("ANON-1", after.getString(Tag.PatientID));
        assertArrayEquals(before, after.getSafeBytes(Tag.PixelData), "画素は元のまま");
    }

    @Test
    void implicitVrLittleEndian_isWrittenAndReadBack() throws IOException {
        assertRawRoundTrip(UID.ImplicitVRLittleEndian);
    }

    @Test
    void explicitVrLittleEndian_isWrittenAndReadBack() throws IOException {
        assertRawRoundTrip(UID.ExplicitVRLittleEndian);
    }

    @Test
    void jpegBaseline_fragmentsAreCarriedOverByteForByte() throws IOException {
        Path src = TestDicomFiles.writeJpegBaseline(dir.resolve("jpeg.dcm"), "1.2.3.4", "1.2.3.4.5", "1.2.3.4.5.6", 3, 120);
        String[] ts = new String[1];
        List<byte[]> before = fragmentsOf(read(src, ts));
        assertEquals(UID.JPEGBaseline8Bit, ts[0]);
        assertEquals(4, before.size(), "基本オフセットテーブル＋3 フレーム");

        Path out = roundTrip(src);

        Attributes after = read(out, ts);
        assertEquals(UID.JPEGBaseline8Bit, ts[0], "圧縮のまま書く（再圧縮・復号をしない）");
        assertEquals("ANON-1", after.getString(Tag.PatientID));
        List<byte[]> afterFrags = fragmentsOf(after);
        assertEquals(before.size(), afterFrags.size());
        for (int i = 0; i < before.size(); i++) {
            assertArrayEquals(before.get(i), afterFrags.get(i), "フラグメント " + i + " のバイト列");
        }
        assertTrue(afterFrags.get(1).length > 0, "フレームが空でない（空同士の一致で通らないように）");
    }

    private static List<byte[]> fragmentsOf(Attributes ds) throws IOException {
        Fragments frags = (Fragments) ds.getValue(Tag.PixelData);
        List<byte[]> list = new ArrayList<>();
        for (Object f : frags) {
            // IncludeBulkData.YES で読むと、フラグメントは byte[]（先頭の基本オフセットテーブルが空のときは Value.NULL）。
            list.add(f instanceof byte[] b ? b : new byte[0]);
        }
        return list;
    }
}
