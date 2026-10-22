/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.vis.graphynext.dicom.ParametricMapFrameExpander;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Base64;
import java.util.List;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

/** Fusion の演算結果（乗算など）を Parametric Map として保存する経路（Modality=OT・Float・メタデータ引き継ぎ）。 */
class DerivedParametricMapTest {

    private static final double[] IOP = {1, 0, 0, 0, 1, 0};

    private static Attributes ctTemplate() {
        Attributes t = new Attributes();
        t.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        t.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.Modality, VR.CS, "CT");
        t.setString(Tag.PatientID, VR.LO, "P001");
        t.setString(Tag.PatientName, VR.PN, "Test^Patient");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        t.setString(Tag.FrameOfReferenceUID, VR.UI, "1.2.3.9");
        t.setString(Tag.WindowCenter, VR.DS, "40");
        t.setString(Tag.WindowWidth, VR.DS, "400");
        t.setString(Tag.RescaleType, VR.LO, "HU");
        return t;
    }

    private static byte[] floats(float... v) {
        ByteBuffer b = ByteBuffer.allocate(v.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (float f : v) b.putFloat(f);
        return b.array();
    }

    private static DerivedSeriesRequest request(DerivedSeriesRequest.ParametricMap pm, byte[] px) {
        return new DerivedSeriesRequest("1.2.3", "1.2.4", "FG x BG", null, 2, 2,
                new double[] {1.5, 2.5}, 3.0, 3.0, IOP, null, "FG x BG", null, null, null, null, null, pm,
                List.of(new DerivedSeriesRequest.Frame(1, new double[] {10, 20, 30},
                        Base64.getEncoder().encodeToString(px))));
    }

    @Test
    void writesFloatParametricMapThatTheExpanderReadsBackBitExact() throws Exception {
        float[] v = {1.5f, -2.25f, Float.NaN, 1.0e6f};
        byte[] px = floats(v);
        var pm = new DerivedSeriesRequest.ParametricMap("FUSION_MULT", "FG x BG [HU x SUVbw]", "{FUSION_PRODUCT}", "HU x SUVbw");
        DerivedSeriesRequest req = request(pm, px);

        Attributes a = new DerivedSeriesService(null, null)
                .buildParametricMapInstance(ctTemplate(), req, "9.9.9", 1004, req.frames().get(0), px);

        assertEquals(UID.ParametricMapStorage, a.getString(Tag.SOPClassUID));
        assertEquals("OT", a.getString(Tag.Modality));
        // 元の患者・検査・座標系は引き継ぐ
        assertEquals("P001", a.getString(Tag.PatientID));
        assertEquals("Test^Patient", a.getString(Tag.PatientName));
        assertEquals("1.2.3", a.getString(Tag.StudyInstanceUID));
        assertEquals("1.2.3.9", a.getString(Tag.FrameOfReferenceUID));
        assertEquals("9.9.9", a.getString(Tag.SeriesInstanceUID));
        // 元の CT のものは持ち込まない（Rescale・窓・単位）
        assertFalse(a.contains(Tag.RescaleSlope));
        assertFalse(a.contains(Tag.RescaleIntercept));
        assertFalse(a.contains(Tag.RescaleType));
        assertFalse(a.contains(Tag.WindowCenter));
        assertFalse(a.contains(Tag.PixelData));
        assertEquals(32, a.getInt(Tag.BitsAllocated, 0));
        // 幾何は Functional Groups にある
        assertNotNull(a.getNestedDataset(Tag.SharedFunctionalGroupsSequence));
        assertFalse(a.contains(Tag.ImagePositionPatient));
        // 値は NaN も含めて 1 ビットも変わらない
        assertEquals(px.length, a.getBytes(Tag.FloatPixelData).length);
        float[] back = ParametricMapFrameExpander.frameValues(a, 0);
        assertNotNull(back);
        assertEquals(v.length, back.length);
        for (int i = 0; i < v.length; i++) {
            assertEquals(Float.floatToRawIntBits(v[i]), Float.floatToRawIntBits(back[i]), "voxel " + i);
        }
        assertEquals("HU x SUVbw", ParametricMapFrameExpander.unitOfFrame(a, 0));
    }

    @Test
    void parametricMapNeedsGeometry() {
        var pm = new DerivedSeriesRequest.ParametricMap("L", "e", "1", "u");
        DerivedSeriesRequest noIop = new DerivedSeriesRequest("1.2.3", "1.2.4", "x", null, 2, 2,
                new double[] {1, 1}, 1, 1, null, null, null, null, null, null, null, null, pm,
                List.of(new DerivedSeriesRequest.Frame(1, new double[] {0, 0, 0}, "")));
        var svc = new DerivedSeriesService(null, null);
        assertThrows(IllegalArgumentException.class, () -> svc.create(noIop));
    }
}
