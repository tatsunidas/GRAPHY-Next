/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * H64: ラベルの volume（スライスごとの平面）から BINARY SEG を作る。
 * 104 ラベルのような多ラベルの結果を「ラベル × スライス」の 0/1 マスクで送らずに済ませる形。
 */
class SegExportLabelPlanesTest {

    @TempDir
    Path dir;

    private static final int ROWS = 2;
    private static final int COLS = 3;

    private Attributes exportAndRead(SegExportRequest req) throws Exception {
        Path header = dir.resolve("src.dcm");
        Attributes src = new Attributes();
        src.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        src.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.9");
        src.setString(Tag.PatientID, VR.LO, "P");
        src.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        try (DicomOutputStream out = new DicomOutputStream(header.toFile())) {
            out.writeDataset(src.createFileMetaInformation(UID.ExplicitVRLittleEndian), src);
        }
        DicomStorageService storage = mock(DicomStorageService.class);
        when(storage.resolveFiles(anyString(), anyList())).thenReturn(List.of(header));
        Path stored = dir.resolve("seg.dcm");
        doAnswer(inv -> {
            Files.copy((Path) inv.getArgument(0), stored);
            return null;
        }).when(storage).ingest(any(Path.class));
        @SuppressWarnings("unchecked")
        ObjectProvider<WebDicomDataService> web = mock(ObjectProvider.class);
        new SegExportService(storage, web).export(req);
        try (DicomInputStream in = new DicomInputStream(stored.toFile())) {
            return in.readDataset();
        }
    }

    private static SegExportRequest request(SegExportRequest.LabelPlanes lp) {
        return new SegExportRequest("1.2.3", "1.2.3.4", ROWS, COLS, new double[]{1, 0, 0, 0, 1, 0},
                new double[]{0.5, 0.5}, 2.0, null, "labels", List.of(), null, lp);
    }

    private static String plane(int... values) {
        byte[] b = new byte[values.length];
        for (int i = 0; i < values.length; i++) {
            b[i] = (byte) values[i];
        }
        return Base64.getEncoder().encodeToString(b);
    }

    /** フレーム f（0 始まり）の 0/1 を取り出す（LSB-first）。 */
    private static int[] frame(byte[] packed, int f) {
        int[] out = new int[ROWS * COLS];
        for (int i = 0; i < out.length; i++) {
            long bit = (long) f * out.length + i;
            out[i] = (packed[(int) (bit >> 3)] >> (int) (bit & 7)) & 1;
        }
        return out;
    }

    @Test
    void expandsEachLabelIntoItsOwnFrames_andDropsEmptyLabels() throws Exception {
        SegExportRequest.LabelPlanes lp = new SegExportRequest.LabelPlanes(1,
                List.of(new SegExportRequest.Label(1, "spleen", new int[]{0, 200, 0}, null),
                        new SegExportRequest.Label(7, "liver", null, "v1"),
                        new SegExportRequest.Label(9, "absent", null, null)),
                List.of(new SegExportRequest.Plane("1.2.3.4.1", new double[]{0, 0, 0}, plane(1, 0, 7, 0, 0, 0)),
                        new SegExportRequest.Plane("1.2.3.4.2", new double[]{0, 0, 2}, plane(0, 7, 7, 1, 0, 3))));
        Attributes seg = exportAndRead(request(lp));

        Sequence segs = seg.getSequence(Tag.SegmentSequence);
        assertEquals(2, segs.size(), "前景の無いラベル（9）はセグメントにしない");
        assertEquals("spleen", segs.get(0).getString(Tag.SegmentLabel));
        assertEquals(1, segs.get(0).getInt(Tag.SegmentNumber, 0));
        assertEquals("liver", segs.get(1).getString(Tag.SegmentLabel));
        assertEquals(2, segs.get(1).getInt(Tag.SegmentNumber, 0));
        assertEquals(4, seg.getInt(Tag.NumberOfFrames, 0), "spleen 2 枚 + liver 2 枚");

        byte[] px = seg.getBytes(Tag.PixelData);
        // セグメント順 → 平面順。表に無い値（3）は背景
        assertArrayEquals(new int[]{1, 0, 0, 0, 0, 0}, frame(px, 0));
        assertArrayEquals(new int[]{0, 0, 0, 1, 0, 0}, frame(px, 1));
        assertArrayEquals(new int[]{0, 0, 1, 0, 0, 0}, frame(px, 2));
        assertArrayEquals(new int[]{0, 1, 1, 0, 0, 0}, frame(px, 3));

        List<String> refs = new ArrayList<>();
        for (Attributes pf : seg.getSequence(Tag.PerFrameFunctionalGroupsSequence)) {
            refs.add(pf.getNestedDataset(Tag.DerivationImageSequence)
                    .getNestedDataset(Tag.SourceImageSequence).getString(Tag.ReferencedSOPInstanceUID));
        }
        assertEquals(List.of("1.2.3.4.1", "1.2.3.4.2", "1.2.3.4.1", "1.2.3.4.2"), refs);
    }

    @Test
    void readsUint16LittleEndian() throws Exception {
        byte[] b = new byte[ROWS * COLS * 2];
        b[0] = (byte) 0x2c; // 300 = 0x012c
        b[1] = 0x01;
        b[4] = 0x2c;        // 44（上位バイト 0）＝別の値
        SegExportRequest.LabelPlanes lp = new SegExportRequest.LabelPlanes(2,
                List.of(new SegExportRequest.Label(300, "big", null, null)),
                List.of(new SegExportRequest.Plane("1.2.3.4.1", new double[]{0, 0, 0}, Base64.getEncoder().encodeToString(b))));
        Attributes seg = exportAndRead(request(lp));
        assertEquals(1, seg.getInt(Tag.NumberOfFrames, 0));
        assertArrayEquals(new int[]{1, 0, 0, 0, 0, 0}, frame(seg.getBytes(Tag.PixelData), 0));
    }

    @Test
    void rejectsBadPlanes() {
        SegExportRequest.Label l = new SegExportRequest.Label(1, "a", null, null);
        SegExportRequest.Plane shortPlane = new SegExportRequest.Plane("s", new double[]{0, 0, 0}, plane(1, 0));
        assertThrows(IllegalArgumentException.class,
                () -> SegExportService.expandLabelPlanes(new SegExportRequest.LabelPlanes(1, List.of(l), List.of(shortPlane)), ROWS * COLS));
        SegExportRequest.Plane empty = new SegExportRequest.Plane("s", new double[]{0, 0, 0}, plane(0, 0, 0, 0, 0, 0));
        assertThrows(IllegalArgumentException.class,
                () -> SegExportService.expandLabelPlanes(new SegExportRequest.LabelPlanes(1, List.of(l), List.of(empty)), ROWS * COLS),
                "どのラベルにも前景が無ければ作らない");
        assertThrows(IllegalArgumentException.class,
                () -> SegExportService.expandLabelPlanes(new SegExportRequest.LabelPlanes(1, List.of(l, l), List.of(empty)), ROWS * COLS),
                "値の重複");
        assertThrows(IllegalArgumentException.class,
                () -> SegExportService.expandLabelPlanes(new SegExportRequest.LabelPlanes(3, List.of(l), List.of(empty)), ROWS * COLS));
    }
}
