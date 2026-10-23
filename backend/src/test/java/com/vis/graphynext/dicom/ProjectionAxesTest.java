/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/** CR/DX/MG/口内法は Z を Shot（kind=shot）で提示する。スタック軸は z のまま。体積（CT/MR 等）は従来の Z/C/T。 */
class ProjectionAxesTest {

    private static final String CR = "1.2.840.10008.5.1.4.1.1.1";
    private static final String DX_PRES = "1.2.840.10008.5.1.4.1.1.1.1";
    private static final String MG_PROC = "1.2.840.10008.5.1.4.1.1.1.2.1";
    private static final String CT = "1.2.840.10008.5.1.4.1.1.2";

    @Test
    void stillProjectionSeries_getShotAxis_withStackOnZ() {
        SeriesLayout.Axes a = SeriesLayoutAssembler.projectionAxes(List.of(CR, DX_PRES, MG_PROC));
        assertNotNull(a);
        assertEquals("Shot", a.z().label());
        assertEquals("shot", a.z().kind());
        assertEquals("z", a.stackAxis());
        assertEquals(false, a.loaderFrames());
    }

    @Test
    void volumeSeries_keepDefaultAxes() {
        assertNull(SeriesLayoutAssembler.projectionAxes(List.of(CT, CT)));
        assertNull(SeriesLayoutAssembler.projectionAxes(List.of(CR, CT)), "1 つでも別の SOP が混じれば従来どおり");
        assertNull(SeriesLayoutAssembler.projectionAxes(Arrays.asList(CR, null)), "SOP クラス不明は従来どおり");
        assertNull(SeriesLayoutAssembler.projectionAxes(List.of()));
    }

    @Test
    void assembler_attachesTheAxesForCr_andLeavesCtAlone() {
        SeriesLayout cr = SeriesLayoutAssembler.fromAttributes(List.of(img(CR, "1.1", 1), img(CR, "1.2", 2)));
        assertEquals(2, cr.nZ());
        assertEquals("shot", cr.axes().z().kind());
        SeriesLayout ct = SeriesLayoutAssembler.fromAttributes(List.of(img(CT, "2.1", 1), img(CT, "2.2", 2)));
        assertNull(ct.axes(), "CT は軸の提示なし（既定の Z/C/T）");
    }

    private static Attributes img(String sopClass, String sop, int instanceNumber) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, sopClass);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
        ds.setInt(Tag.InstanceNumber, VR.IS, instanceNumber);
        ds.setInt(Tag.Rows, VR.US, 8);
        ds.setInt(Tag.Columns, VR.US, 8);
        ds.setInt(Tag.BitsAllocated, VR.US, 16);
        return ds;
    }
}
