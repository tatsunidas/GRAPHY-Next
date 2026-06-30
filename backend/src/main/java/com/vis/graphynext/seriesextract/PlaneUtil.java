/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

/** ImageOrientationPatient から代表面（AXIAL/SAGITTAL/CORONAL）を判定する（GRAPHY PlanarSupport 相当）。 */
public final class PlaneUtil {

    private PlaneUtil() {
    }

    public static final String AXIAL = "AXIAL";
    public static final String SAGITTAL = "SAGITTAL";
    public static final String CORONAL = "CORONAL";

    /** 面の名称（判定不能なら null）。法線の優位軸: |x|→SAGITTAL, |y|→CORONAL, |z|→AXIAL。 */
    public static String planeOf(Attributes header) {
        if (header == null) {
            return null;
        }
        double[] iop = header.getDoubles(Tag.ImageOrientationPatient);
        if (iop == null || iop.length < 6) {
            return null;
        }
        // 法線 = row × col
        double nx = iop[1] * iop[5] - iop[2] * iop[4];
        double ny = iop[2] * iop[3] - iop[0] * iop[5];
        double nz = iop[0] * iop[4] - iop[1] * iop[3];
        double ax = Math.abs(nx);
        double ay = Math.abs(ny);
        double az = Math.abs(nz);
        if (az >= ax && az >= ay) {
            return AXIAL;
        }
        if (ax >= ay) {
            return SAGITTAL;
        }
        return CORONAL;
    }
}
