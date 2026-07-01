/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.imagej;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ImageJ ROI エンコード/デコードの往復テスト（純ロジック。ij 依存の健全性も兼ねる）。
 */
class ImageJRoiServiceTest {

    private final ImageJRoiService service = new ImageJRoiService();

    @Test
    void polygonRoundTrip() throws Exception {
        ImageJRoiDto poly = new ImageJRoiDto(
                "poly1", "polygon", 3,
                new float[]{10, 40, 40, 10}, new float[]{10, 10, 40, 40},
                null, null, null, null, null);
        byte[] zip = service.encodeRoiSet(List.of(poly));
        assertNotNull(zip);
        assertTrue(zip.length > 0);

        List<ImageJRoiDto> back = service.decode(zip, "RoiSet.zip");
        assertEquals(1, back.size());
        ImageJRoiDto d = back.get(0);
        assertEquals("polygon", d.type());
        assertEquals(3, d.position());
        assertNotNull(d.xs());
        assertEquals(4, d.xs().length);
        assertEquals(10f, d.xs()[0], 0.5f);
    }

    @Test
    void ovalAndRectBboxRoundTrip() throws Exception {
        ImageJRoiDto oval = new ImageJRoiDto("oval1", "oval", 1, null, null, 20.0, 30.0, 50.0, 60.0, null);
        ImageJRoiDto rect = new ImageJRoiDto("rect1", "rect", 2, null, null, 5.0, 6.0, 15.0, 25.0, null);
        byte[] zip = service.encodeRoiSet(List.of(oval, rect));

        List<ImageJRoiDto> back = service.decode(zip, "RoiSet.zip");
        assertEquals(2, back.size());
        ImageJRoiDto o = back.stream().filter(r -> "oval".equals(r.type())).findFirst().orElseThrow();
        assertEquals(20.0, o.bx(), 0.5);
        assertEquals(50.0, o.bw(), 0.5);
        ImageJRoiDto r = back.stream().filter(r2 -> "rect".equals(r2.type())).findFirst().orElseThrow();
        assertEquals(15.0, r.bw(), 0.5);
    }

    @Test
    void singleRoiEncodeDecodes() throws Exception {
        ImageJRoiDto free = new ImageJRoiDto(
                "free", "freehand", 0,
                new float[]{0, 5, 10, 5}, new float[]{0, 8, 0, -8},
                null, null, null, null, null);
        byte[] roi = service.encodeSingle(free);
        List<ImageJRoiDto> back = service.decode(roi, "free.roi");
        assertEquals(1, back.size());
        assertNotNull(back.get(0).xs());
    }

    @Test
    void uniqueNamesForDuplicateLabels() throws Exception {
        ImageJRoiDto a = new ImageJRoiDto("same", "polygon", 1, new float[]{0, 1, 1}, new float[]{0, 0, 1}, null, null, null, null, null);
        ImageJRoiDto b = new ImageJRoiDto("same", "polygon", 2, new float[]{0, 2, 2}, new float[]{0, 0, 2}, null, null, null, null, null);
        byte[] zip = service.encodeRoiSet(List.of(a, b));
        List<ImageJRoiDto> back = service.decode(zip, "RoiSet.zip");
        assertEquals(2, back.size(), "duplicate labels must not collide into one zip entry");
    }
}
