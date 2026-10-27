/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.CompressedFixtures;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Date;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * タグの編集・患者情報の書き換えは、圧縮された画素を<b>そのままコピー</b>する（再符号化も復号もしない）。
 * 編集後も圧縮のまま、フラグメントがバイト一致し、復号した画素が元と一致する。
 */
class CompressedFileEditTest {

    private static byte[] decoded(PixelCodec c, Path f) throws Exception {
        Attributes ds;
        String ts;
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
            ts = in.getTransferSyntax();
        }
        return c.decompress(ds, ts);
    }

    private static String patientName(Path f) throws Exception {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            return in.readDatasetUntilPixelData().getString(Tag.PatientName);
        }
    }

    @Test
    void タグ編集と患者情報の書き換えで_圧縮された画素が変わらない(@TempDir Path dir) throws Exception {
        PixelCodec codec = new PixelCodec(new DicomProperties());
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
        Attributes ds = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7301", "EDITPID");
        byte[] want = ds.getBytes(Tag.PixelData);
        Path src = CompressedFixtures.compressed(dir.resolve("src.dcm"), ds, UID.JPEGLSLossless);
        List<byte[]> before = CompressedFixtures.fragments(src);

        Path edited = dir.resolve("edited.dcm");
        TagEditService.rewrite(src, edited,
                List.of(new TagEditService.CheckedEdit(Tag.PatientName, VR.PN, false, new String[] {"EDITED^NAME"})), new Date());
        Path moved = dir.resolve("moved.dcm");
        DbAdminService.writeRewritten(src, moved, "REWRITTEN^NAME", null, null, "NEWPID");

        for (Path out : List.of(edited, moved)) {
            assertEquals(UID.JPEGLSLossless, CompressedFixtures.tsOf(out), "圧縮のまま");
            List<byte[]> after = CompressedFixtures.fragments(out);
            assertEquals(before.size(), after.size());
            for (int i = 0; i < before.size(); i++) {
                assertArrayEquals(before.get(i), after.get(i), "フラグメントがバイト一致 " + out.getFileName());
            }
            assertArrayEquals(want, decoded(codec, out), "復号した画素が元と一致 " + out.getFileName());
        }
        // 検出器の確認: 編集が実際に効いている（何も書き換えず素通ししただけではない）
        assertEquals("EDITED^NAME", patientName(edited));
        assertEquals("REWRITTEN^NAME", patientName(moved));
    }
}
