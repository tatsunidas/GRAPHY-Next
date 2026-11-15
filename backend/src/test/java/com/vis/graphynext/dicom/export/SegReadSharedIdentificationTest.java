/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import com.vis.graphynext.dicom.SegFrameExpander;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 外部製 SEG（TCIA の ePAD・3D Slicer 製）は、単一セグメントの ReferencedSegmentNumber を全フレーム共通の項目
 * （Shared Functional Groups）にだけ持つ。フレームごとだけを読むと番号が 0 になり、SegmentSequence の
 * 番号 1・名前「Tissue」と合わず、「0: Segment 0」と読まれていた（2026-11-15、NSCLC Radiogenomics の実データで発見）。
 */
class SegReadSharedIdentificationTest {

    @TempDir
    Path dir;

    private static final String STUDY = "1.2.3";
    private static final String SERIES = "1.2.3.77";

    /** 4×4・2 フレームの 8 ビット SEG。識別を共通側に置くか、フレームごとに置くかを選べる。 */
    private Path writeSeg(boolean sharedOnly) throws Exception {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, SegFrameExpander.SOP_CLASS_SEG);
        ds.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.77.1");
        ds.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
        ds.setString(Tag.SeriesInstanceUID, VR.UI, SERIES);
        ds.setString(Tag.Modality, VR.CS, "SEG");
        ds.setInt(Tag.Rows, VR.US, 4);
        ds.setInt(Tag.Columns, VR.US, 4);
        ds.setInt(Tag.NumberOfFrames, VR.IS, 2);
        ds.setInt(Tag.BitsAllocated, VR.US, 8);
        ds.setInt(Tag.BitsStored, VR.US, 8);
        ds.setInt(Tag.HighBit, VR.US, 7);
        ds.setInt(Tag.PixelRepresentation, VR.US, 0);
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        Attributes seg = new Attributes();
        seg.setInt(Tag.SegmentNumber, VR.US, 1);
        seg.setString(Tag.SegmentLabel, VR.LO, "Tissue");
        ds.newSequence(Tag.SegmentSequence, 1).add(seg);

        Attributes segId = new Attributes();
        segId.setInt(Tag.ReferencedSegmentNumber, VR.US, 1);
        if (sharedOnly) {
            Attributes shared = new Attributes();
            shared.newSequence(Tag.SegmentIdentificationSequence, 1).add(segId);
            ds.newSequence(Tag.SharedFunctionalGroupsSequence, 1).add(shared);
        }
        Sequence pf = ds.newSequence(Tag.PerFrameFunctionalGroupsSequence, 2);
        for (int i = 0; i < 2; i++) {
            Attributes fr = new Attributes();
            if (!sharedOnly) {
                fr.newSequence(Tag.SegmentIdentificationSequence, 1).add(new Attributes(segId));
            }
            Attributes pp = new Attributes();
            pp.setDouble(Tag.ImagePositionPatient, VR.DS, 0, 0, i * 2.0);
            fr.newSequence(Tag.PlanePositionSequence, 1).add(pp);
            Attributes src = new Attributes();
            src.setString(Tag.ReferencedSOPClassUID, VR.UI, UID.CTImageStorage);
            src.setString(Tag.ReferencedSOPInstanceUID, VR.UI, "1.2.3.9." + i);
            Attributes deriv = new Attributes();
            deriv.newSequence(Tag.SourceImageSequence, 1).add(src);
            fr.newSequence(Tag.DerivationImageSequence, 1).add(deriv);
            pf.add(fr);
        }
        byte[] px = new byte[32];
        px[5] = 1;
        px[16 + 6] = 1; // 各フレームに前景 1 画素
        ds.setBytes(Tag.PixelData, VR.OB, px);
        Path f = dir.resolve(sharedOnly ? "shared.dcm" : "perframe.dcm");
        try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
            out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
        }
        return f;
    }

    private SegImportResult read(Path f) throws Exception {
        DicomStorageService storage = mock(DicomStorageService.class);
        when(storage.resolveFiles(anyString(), anyList())).thenReturn(List.of(f));
        @SuppressWarnings("unchecked")
        ObjectProvider<WebDicomDataService> noWeb = mock(ObjectProvider.class);
        return new SegReadService(storage, noWeb).readSegments(STUDY, SERIES);
    }

    @Test
    void sharedOnlyIdentification_keepsTheDeclaredNumberAndLabel() throws Exception {
        SegImportResult r = read(writeSeg(true));
        assertEquals(1, r.segments().size());
        assertEquals(1, r.segments().get(0).number(), "共通の項目の番号 1（0 ではない）");
        assertEquals("Tissue", r.segments().get(0).label(), "SegmentSequence の名前が引ける（「Segment 0」ではない）");
    }

    @Test
    void perFrameIdentification_isUnchanged() throws Exception {
        SegImportResult r = read(writeSeg(false));
        assertEquals(1, r.segments().size());
        assertEquals(1, r.segments().get(0).number());
        assertEquals("Tissue", r.segments().get(0).label());
        assertTrue(r.segments().get(0).frames().isEmpty() || r.segments().get(0).frames().size() == 2);
    }
}
