/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Test;

/** 派生シリーズの SOP Class: 元が Parametric Map なら画像の SOP にする（fw/nifti-import.md §3.1・F4）。 */
class DerivedSopClassTest {

    @Test
    void keepsTheSourceSopClassForOrdinaryImages() {
        assertEquals(UID.CTImageStorage, DerivedSeriesService.derivedSopClass(UID.CTImageStorage, "CT"));
        assertEquals(UID.SecondaryCaptureImageStorage, DerivedSeriesService.derivedSopClass(null, "MR"));
    }

    @Test
    void parametricMapSourceBecomesAnImageSopOfItsModality() {
        // 書くのは 16 bit の PixelData とトップレベルの幾何なので、Parametric Map のままでは不正なインスタンスになる
        assertEquals(UID.MRImageStorage, DerivedSeriesService.derivedSopClass(UID.ParametricMapStorage, "MR"));
        assertEquals(UID.CTImageStorage, DerivedSeriesService.derivedSopClass(UID.ParametricMapStorage, "ct"));
        assertEquals(UID.SecondaryCaptureImageStorage,
                DerivedSeriesService.derivedSopClass(UID.ParametricMapStorage, "OT"));
    }
}
