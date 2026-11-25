/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.vis.graphynext.nifti.FloatNiftiFixture;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** float の Parametric Map の無限大は、読み込みで「値なし」（NaN）に直る。NaN・有限の値はそのまま。 */
class InfinityAsNaNOnLoadTest {

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    @Test
    void positiveAndNegativeInfinityBecomeNaN_andOtherValuesAreUntouched(@TempDir Path tmp) throws Exception {
        Path nii = FloatNiftiFixture.write(Files.createTempFile(tmp, "f", ".nii"), 4, 4, 1, 1.0, 1.0, 1.0,
                (i, j, k) -> 1.5f + i);
        List<Attributes> frames = FloatNiftiFixture.toParametricMap(nii, "P", "P", "1.2.3", "1.2.3.4", "1");
        Attributes ds = frames.get(0);
        ByteBuffer b = ByteBuffer.wrap(ds.getBytes(Tag.FloatPixelData)).order(ByteOrder.LITTLE_ENDIAN);
        b.putFloat(0, Float.POSITIVE_INFINITY);
        b.putFloat(4, Float.NEGATIVE_INFINITY);
        b.putFloat(8, Float.NaN);
        ds.setBytes(Tag.FloatPixelData, VR.OF, b.array());

        RadiomicsMapEngine.Loaded l = RadiomicsMapEngine.processorFrom(ds, "1.2.3.4.1", null, false);
        assertNotNull(l);
        float[] v = (float[]) l.ip().getPixels();
        assertTrue(Float.isNaN(v[0]), "+Inf → NaN");
        assertTrue(Float.isNaN(v[1]), "-Inf → NaN");
        assertTrue(Float.isNaN(v[2]), "NaN はそのまま");
        assertEquals(1.5f + 3, v[3], 0f, "有限の値は変わらない");
        for (float x : v) {
            assertTrue(Float.isNaN(x) || Float.isFinite(x), "無限大は残らない");
        }
    }
}
