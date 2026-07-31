/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * ボリューム構築前のメモリ量予測に使うピクセル形式の抽出（{@code fw/volume-memory-guard.md} V2）。
 *
 * <p>frontend の {@code viewer/volumeMemory.ts} が bytes/voxel を決めるのに使う値なので、
 * <b>RescaleSlope/Intercept が欠けていても既定値（1 / 0）で返る</b>ことが重要。
 * 欠損時に 0 を返すと「非整数ではない」判定が狂い、PET の 4B/voxel を 2B と見誤る。
 */
class SeriesLayoutPixelFormatTest {

    private static Attributes ct() {
        Attributes ds = new Attributes();
        ds.setInt(Tag.BitsAllocated, VR.US, 16);
        ds.setInt(Tag.PixelRepresentation, VR.US, 1);
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        ds.setDouble(Tag.RescaleSlope, VR.DS, 1.0);
        ds.setDouble(Tag.RescaleIntercept, VR.DS, -1024.0);
        return ds;
    }

    @Test
    void ct_readsAllFields() {
        SeriesLayout.PixelFormat pf = SeriesLayoutAssembler.readPixelFormat(ct());
        assertNotNull(pf);
        assertEquals(16, pf.bitsAllocated());
        assertEquals(1, pf.pixelRepresentation());
        assertEquals(1, pf.samplesPerPixel());
        assertEquals(1.0, pf.rescaleSlope());
        assertEquals(-1024.0, pf.rescaleIntercept());
    }

    @Test
    void pet_keepsNonIntegerSlope() {
        // 非整数 slope は frontend 側で Float32Array（4B/voxel）判定の決め手になる。丸めてはいけない。
        Attributes ds = ct();
        ds.setDouble(Tag.RescaleSlope, VR.DS, 0.0123456);
        SeriesLayout.PixelFormat pf = SeriesLayoutAssembler.readPixelFormat(ds);
        assertEquals(0.0123456, pf.rescaleSlope());
    }

    @Test
    void missingRescale_defaultsToIdentity() {
        Attributes ds = new Attributes();
        ds.setInt(Tag.BitsAllocated, VR.US, 8);
        SeriesLayout.PixelFormat pf = SeriesLayoutAssembler.readPixelFormat(ds);
        assertNotNull(pf);
        assertEquals(8, pf.bitsAllocated());
        assertEquals(0, pf.pixelRepresentation());
        assertEquals(1, pf.samplesPerPixel(), "SamplesPerPixel の既定は 1");
        assertEquals(1.0, pf.rescaleSlope(), "欠損時に 0 を返すと非整数判定が狂う");
        assertEquals(0.0, pf.rescaleIntercept());
    }

    @Test
    void rgb_keepsSamplesPerPixel() {
        Attributes ds = new Attributes();
        ds.setInt(Tag.BitsAllocated, VR.US, 8);
        ds.setInt(Tag.SamplesPerPixel, VR.US, 3);
        assertEquals(3, SeriesLayoutAssembler.readPixelFormat(ds).samplesPerPixel());
    }

    @Test
    void noBitsAllocated_returnsNull() {
        // 画素を持たないヘッダ。予測をスキップさせる（frontend は null で予測を諦める）。
        assertNull(SeriesLayoutAssembler.readPixelFormat(new Attributes()));
    }

    @Test
    void noSpatialLayout_hasNullPixelFormat() {
        SeriesLayout l = SeriesLayout.noSpatial(0, 0, 0, null, null, java.util.List.of());
        assertNull(l.pixelFormat());
    }
}
