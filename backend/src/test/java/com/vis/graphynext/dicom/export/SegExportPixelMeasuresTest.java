/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
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
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * SEG の Pixel Measures: SliceThickness は公称の厚み、SpacingBetweenSlices は隣接スライスの中心間距離で、
 * 間隔が一様でないとき（{@code spacingBetweenSlices = 0}）は書かない。
 */
class SegExportPixelMeasuresTest {

    @TempDir
    Path dir;

    private Attributes pixelMeasuresOf(SegExportRequest req) throws Exception {
        Attributes src = new Attributes();
        src.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        src.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.9");
        src.setString(Tag.PatientID, VR.LO, "P");
        src.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        Path header = dir.resolve("src.dcm");
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
            Attributes seg = in.readDataset();
            return seg.getSequence(Tag.SharedFunctionalGroupsSequence).get(0)
                    .getSequence(Tag.PixelMeasuresSequence).get(0);
        }
    }

    private static SegExportRequest request(double thickness, double spacingBetweenSlices) {
        SegExportRequest.LabelPlanes lp = new SegExportRequest.LabelPlanes(1,
                List.of(new SegExportRequest.Label(1, "a", null, null)),
                List.of(new SegExportRequest.Plane("1.2.3.4.1", new double[]{0, 0, 0},
                        Base64.getEncoder().encodeToString(new byte[]{1, 0, 0, 0, 0, 0}))));
        return new SegExportRequest("1.2.3", "1.2.3.4", 2, 3, new double[]{1, 0, 0, 0, 1, 0},
                new double[]{0.5, 0.5}, thickness, null, "m", List.of(), null, lp, spacingBetweenSlices);
    }

    @Test
    void writesThicknessAndSpacingSeparately_whenUniform() throws Exception {
        Attributes pm = pixelMeasuresOf(request(5.0, 2.5));
        assertEquals(5.0, pm.getDouble(Tag.SliceThickness, 0), 1e-9, "公称の厚み");
        assertEquals(2.5, pm.getDouble(Tag.SpacingBetweenSlices, 0), 1e-9, "中心間距離");
    }

    @Test
    void omitsSpacingBetweenSlices_whenNotUniform() throws Exception {
        Attributes pm = pixelMeasuresOf(request(2.0, 0));
        assertEquals(2.0, pm.getDouble(Tag.SliceThickness, 0), 1e-9);
        assertFalse(pm.contains(Tag.SpacingBetweenSlices), "一様でない間隔に 1 つの値は書かない");
    }

    @Test
    void legacyConstructorKeepsUsingThicknessAsSpacing() throws Exception {
        // ラベルの平面を渡す従来の呼び出し（格子が一様な呼び出し側）は、従来どおり両方に同じ値を書く。
        SegExportRequest.LabelPlanes lp = new SegExportRequest.LabelPlanes(1,
                List.of(new SegExportRequest.Label(1, "a", null, null)),
                List.of(new SegExportRequest.Plane("1.2.3.4.1", new double[]{0, 0, 0},
                        Base64.getEncoder().encodeToString(new byte[]{1, 0, 0, 0, 0, 0}))));
        SegExportRequest legacy = new SegExportRequest("1.2.3", "1.2.3.4", 2, 3, new double[]{1, 0, 0, 0, 1, 0},
                new double[]{0.5, 0.5}, 2.0, null, "m", List.of(), null, lp);
        Attributes pm = pixelMeasuresOf(legacy);
        assertEquals(2.0, pm.getDouble(Tag.SliceThickness, 0), 1e-9);
        assertTrue(pm.contains(Tag.SpacingBetweenSlices));
        assertEquals(2.0, pm.getDouble(Tag.SpacingBetweenSlices, 0), 1e-9);
    }
}
