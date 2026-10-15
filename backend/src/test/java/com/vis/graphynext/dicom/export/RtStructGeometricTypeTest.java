/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** RTSTRUCT の ContourGeometricType の読み書き（穴を別輪郭で持つ往復と、種別ごとの点数検証）。 */
class RtStructGeometricTypeTest {

    private final RtStructReadService reader = new RtStructReadService(null, null);
    private final RtStructExportService exporter = new RtStructExportService(null, null);

    private static Attributes contour(String type, double... pts) {
        Attributes ci = new Attributes();
        if (type != null) ci.setString(Tag.ContourGeometricType, VR.CS, type);
        ci.setInt(Tag.NumberOfContourPoints, VR.IS, pts.length / 3);
        ci.setDouble(Tag.ContourData, VR.DS, pts);
        return ci;
    }

    @Test
    void parseKeepsGeometricTypeAndShortContours() {
        Attributes ds = new Attributes();
        Sequence ss = ds.newSequence(Tag.StructureSetROISequence, 1);
        Attributes s = new Attributes();
        s.setInt(Tag.ROINumber, VR.IS, 1);
        s.setString(Tag.ROIName, VR.LO, "A");
        ss.add(s);
        Sequence rc = ds.newSequence(Tag.ROIContourSequence, 1);
        Attributes r = new Attributes();
        r.setInt(Tag.ReferencedROINumber, VR.IS, 1);
        Sequence cs = r.newSequence(Tag.ContourSequence, 4);
        cs.add(contour("CLOSED_PLANAR", 0, 0, 0, 1, 0, 0, 1, 1, 0));
        cs.add(contour(null, 0, 0, 0, 1, 0, 0, 1, 1, 0)); // 未記載は CLOSED_PLANAR
        cs.add(contour("POINT", 5, 5, 5));
        cs.add(contour("OPEN_PLANAR", 0, 0, 0, 1, 1, 0));
        rc.add(r);

        List<RtStructRoiDto> out = reader.parse(ds);
        List<RtStructRoiDto.Contour> c = out.get(0).contours();
        assertEquals(4, c.size());
        assertEquals("CLOSED_PLANAR", c.get(0).geometricType());
        assertEquals("CLOSED_PLANAR", c.get(1).geometricType());
        assertEquals("POINT", c.get(2).geometricType());
        assertEquals(3, c.get(2).points().length);
        assertEquals("OPEN_PLANAR", c.get(3).geometricType());
    }

    private static RtStructExportRequest req(String type, double... pts) {
        var contour = new RtStructExportRequest.Contour("1.2.3", pts, type);
        var roi = new RtStructExportRequest.Roi(1, "A", null, "ORGAN", List.of(contour));
        return new RtStructExportRequest("1.2", "1.3", "1.4", "L", List.of(roi));
    }

    @Test
    void validateChecksPointCountPerType() {
        double[] tri = {0, 0, 0, 1, 0, 0, 1, 1, 0};
        double[] seg = {0, 0, 0, 1, 1, 0};
        double[] one = {2, 2, 2};
        assertDoesNotThrow(() -> exporter.validate(req(null, tri)));
        assertDoesNotThrow(() -> exporter.validate(req("CLOSED_PLANAR", tri)));
        assertDoesNotThrow(() -> exporter.validate(req("OPEN_PLANAR", seg)));
        assertDoesNotThrow(() -> exporter.validate(req("POINT", one)));
        assertThrows(IllegalArgumentException.class, () -> exporter.validate(req("CLOSED_PLANAR", seg)));
        assertThrows(IllegalArgumentException.class, () -> exporter.validate(req("OPEN_PLANAR", one)));
        assertThrows(IllegalArgumentException.class, () -> exporter.validate(req("POINT", seg)));
        assertThrows(IllegalArgumentException.class, () -> exporter.validate(req("CLOSED_NONPLANAR", tri)));
        assertThrows(IllegalArgumentException.class, () -> exporter.validate(req(null, 0, 0, 0, 1)));
    }
}
