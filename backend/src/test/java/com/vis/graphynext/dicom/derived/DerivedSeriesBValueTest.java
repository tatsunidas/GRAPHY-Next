/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.List;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

/** 派生シリーズの DiffusionBValue(0018,9087): 指定時だけ書き、元シリーズの値は引き継がない（computed DWI の目標 b 値）。 */
class DerivedSeriesBValueTest {

    private static Attributes mrDwiTemplate() {
        Attributes t = new Attributes();
        t.setString(Tag.SOPClassUID, VR.UI, UID.MRImageStorage);
        t.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.Modality, VR.CS, "MR");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        t.setDouble(Tag.DiffusionBValue, VR.FD, 800.0); // 元は b=800
        return t;
    }

    private static DerivedSeriesRequest req(Double bValue) {
        return new DerivedSeriesRequest("1.2.3", "1.2.4", "Computed DWI b=200", null, 2, 2,
                new double[] {1.0, 1.0}, 1.0, 1.0, null, null, null, null, null, null, null, bValue, null, null,
                List.of(new DerivedSeriesRequest.Frame(1, null, "")));
    }

    private static Attributes build(DerivedSeriesRequest r) {
        return new DerivedSeriesService(null, null)
                .buildInstance(mrDwiTemplate(), r, "9.9.9", 1, "MR", r.frames().get(0), new byte[8]);
    }

    @Test
    void writesTheRequestedBValueAsFd() {
        Attributes a = build(req(200.0));
        assertEquals(200.0, a.getDouble(Tag.DiffusionBValue, Double.NaN));
        assertEquals(VR.FD, a.getVR(Tag.DiffusionBValue));
    }

    @Test
    void doesNotInheritTheSourceBValueWhenNotRequested() {
        assertFalse(build(req(null)).contains(Tag.DiffusionBValue));
    }

    @Test
    void zeroIsAValidBValue() {
        assertEquals(0.0, build(req(0.0)).getDouble(Tag.DiffusionBValue, Double.NaN));
    }

    @Test
    void rejectsNegativeAndNonFiniteBValues() {
        var svc = new DerivedSeriesService(null, null);
        for (double bad : new double[] {-1.0, Double.NaN, Double.POSITIVE_INFINITY}) {
            assertThrows(IllegalArgumentException.class, () -> svc.create(req(bad)), "b=" + bad);
        }
    }
}
