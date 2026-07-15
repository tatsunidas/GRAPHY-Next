/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * web モード（WADO-RS {@code /metadata} 相当）から届く DICOM SEG の属性を、standalone と同じ
 * per-frame 展開（nZ=フレーム数, frame インデックス付き cell）にできることの回帰テスト。
 */
class SegFrameExpanderTest {

    /** 3 フレーム（1 セグメント、Z 位置が異なる）の SEG インスタンス 1 件を模した Attributes。 */
    private Attributes segInstance(String sopUid, int numberOfFrames) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, org.dcm4che3.data.VR.UI, SegFrameExpander.SOP_CLASS_SEG);
        ds.setString(Tag.SOPInstanceUID, org.dcm4che3.data.VR.UI, sopUid);
        ds.setInt(Tag.Rows, org.dcm4che3.data.VR.US, 4);
        ds.setInt(Tag.Columns, org.dcm4che3.data.VR.US, 4);
        ds.setInt(Tag.NumberOfFrames, org.dcm4che3.data.VR.IS, numberOfFrames);
        ds.setDouble(Tag.ImageOrientationPatient, org.dcm4che3.data.VR.DS, 1, 0, 0, 0, 1, 0);

        Sequence pf = ds.newSequence(Tag.PerFrameFunctionalGroupsSequence, numberOfFrames);
        for (int i = 0; i < numberOfFrames; i++) {
            Attributes frame = new Attributes();
            Attributes segId = new Attributes();
            segId.setInt(Tag.ReferencedSegmentNumber, org.dcm4che3.data.VR.US, 1);
            frame.newSequence(Tag.SegmentIdentificationSequence, 1).add(segId);

            Attributes pp = new Attributes();
            pp.setDouble(Tag.ImagePositionPatient, org.dcm4che3.data.VR.DS, 0, 0, i * 2.0);
            frame.newSequence(Tag.PlanePositionSequence, 1).add(pp);

            pf.add(frame);
        }
        return ds;
    }

    @Test
    void isSegDataset_detectsBySopClassAndByPerFrameSegmentIdentification() {
        assertTrue(SegFrameExpander.isSegDataset(segInstance("1.2.3", 3)));
        assertTrue(SegFrameExpander.isSegDataset(segInstance("1.2.3", 1)));
    }

    @Test
    void layout_expandsMultiFrameSegIntoOneCellPerFrame_notCollapsedToOneSlice() {
        Attributes seg = segInstance("1.2.3", 3);
        SeriesLayout layout = SegFrameExpander.layout(List.of(seg));

        assertEquals(3, layout.nZ(), "3 フレーム SEG は nZ=3（=3 スライス）に展開されるべき");
        assertEquals(1, layout.nC());
        assertEquals(3, layout.cells().size());
        assertEquals(List.of(0, 1, 2), layout.cells().stream().map(SeriesLayout.Cell::frame).sorted().toList());
        layout.cells().forEach(c -> assertEquals("1.2.3", c.sopInstanceUid()));
    }

    @Test
    void seriesLayoutAssembler_fromAttributes_usesSegExpansionInsteadOfClassicSingleFrame() {
        Attributes seg = segInstance("1.2.3", 4);
        SeriesLayout layout = SeriesLayoutAssembler.fromAttributes(List.of(seg));

        // 修正前は classic 経路（1 インスタンス=1 セル）を通り nZ=1 になっていた。
        assertEquals(4, layout.nZ());
        assertEquals(4, layout.cells().size());
    }
}
