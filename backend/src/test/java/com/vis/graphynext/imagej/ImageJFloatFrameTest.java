/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.imagej;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.List;

import org.dcm4che3.data.Attributes;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.vis.graphynext.anonymize.TestDicomFiles;
import com.vis.graphynext.dicom.ParametricMapFrameExpander;
import com.vis.graphynext.nifti.FloatNiftiFixture;

import ij.process.FloatProcessor;

/**
 * ImageJ 連携: Parametric Map から切り出した float のフレームを FloatProcessor にする（fw/nifti-import.md §3.1・F4）。
 * ImageJ の DICOM の読み込みは PixelData しか知らないので、前は開けなかった。
 */
class ImageJFloatFrameTest {

    @Test
    void parametricMapFrameBecomesAFloatProcessorWithTheSameValuesAndNaN(@TempDir Path dir) throws Exception {
        Path nii = FloatNiftiFixture.write(dir.resolve("a.nii"), 5, 4, 2, 1, 1, 1,
                (i, j, k) -> i == 3 && j == 1 ? Float.NaN : (float) (0.001 * (i + 1) + 0.0001 * j + k));
        List<Attributes> pm = FloatNiftiFixture.toParametricMap(nii, "P", "P", "1.2.3", "1.2.3.4", "mm2/s");
        Attributes first = pm.get(0);
        byte[] frame = ParametricMapFrameExpander.extractFrame(first, 0);
        float[] want = ParametricMapFrameExpander.frameValues(first, 0);

        ImageJBridgeService.Loaded l = ImageJBridgeService.floatProcessor(frame);
        assertNotNull(l);
        assertTrue(l.ip() instanceof FloatProcessor);
        assertEquals(first.getInt(org.dcm4che3.data.Tag.Columns, 0), l.ip().getWidth());
        float[] got = (float[]) l.ip().getPixels();
        int nan = 0;
        for (int i = 0; i < want.length; i++) {
            if (Float.isNaN(want[i])) {
                assertTrue(Float.isNaN(got[i]));
                nan++;
            } else {
                assertEquals(want[i], got[i], 0f);
            }
        }
        assertEquals(1, nan, "NaN はそのまま");
    }

    @Test
    void integerFramesAreLeftToImageJsOwnReader(@TempDir Path dir) throws Exception {
        Path f = TestDicomFiles.writeUncompressed(dir.resolve("x.dcm"), "1.2", "1.2.1", "1.2.1.1", 1, 7);
        assertNull(ImageJBridgeService.floatProcessor(java.nio.file.Files.readAllBytes(f)));
    }
}
