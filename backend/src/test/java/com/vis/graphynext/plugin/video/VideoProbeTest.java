/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.video;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** H47: ffprobe を使わない諸元の読み取りと、指紋から決める UID。 */
class VideoProbeTest {

    @Test
    void AVI_MJPEG_の出力を読める() {
        // 実データ（E:/UltrasoundDataset/Kosei_AVI_02s1f/K12.avi）の ffmpeg -i の出力そのもの
        String out = """
                Input #0, avi, from 'K12.avi':
                  Metadata:
                    software        : Lavf59.27.100
                  Duration: 00:01:08.47, start: 0.000000, bitrate: 4895 kb/s
                  Stream #0:0: Video: mjpeg (Baseline) (MJPG / 0x47504A4D), yuvj420p(pc, bt470bg/unknown/unknown), 720x440, 4891 kb/s, 29.97 fps, 29.97 tbr, 29.97 tbn
                At least one output file must be specified
                """;
        VideoProbe.Header h = VideoProbe.parseHeader(out);
        assertEquals("mjpeg", h.codec());
        assertEquals(720, h.width());
        assertEquals(440, h.height());
        assertEquals(29.97, h.fps(), 1e-9);
        assertEquals(68.47, h.durationSec(), 1e-9);
    }

    @Test
    void MP4_H264_の出力を読める_SAR_の角括弧つき() {
        String out = """
                  Duration: 00:00:02.00, start: 0.000000, bitrate: 20 kb/s
                  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 321x241 [SAR 1:1 DAR 321:241], 12 kb/s, 15 fps, 15 tbr, 15360 tbn (default)
                """;
        VideoProbe.Header h = VideoProbe.parseHeader(out);
        assertEquals("h264", h.codec());
        assertEquals(321, h.width());
        assertEquals(241, h.height());
        assertEquals(15, h.fps(), 1e-9);
    }

    @Test
    void 映像が無ければ_null() {
        assertNull(VideoProbe.parseHeader("  Stream #0:0: Audio: aac, 44100 Hz, stereo\n"));
    }

    @Test
    void フレーム数は最後の_frame_を採る() {
        String out = "frame=  100 fps=0.0 q=-1.0 size=N/A\rframe= 2052 fps=0.0 q=-1.0 Lsize=N/A time=00:01:08.43\n";
        assertEquals(2052, VideoProbe.lastFrameCount(out));
    }

    @Test
    void UID_は同じ値から必ず同じになり_名前空間が違えば別になる() {
        String a = VideoProbe.uidFrom("ns", "abc");
        assertEquals(a, VideoProbe.uidFrom("ns", "abc"));
        assertNotEquals(a, VideoProbe.uidFrom("ns2", "abc"));
        assertNotEquals(a, VideoProbe.uidFrom("ns", "abd"));
        assertTrue(a.matches("2\\.25\\.[1-9]\\d*") && a.length() <= 64, a);
    }

    @Test
    void 指紋は内容で決まり覚えておいた値を返す() throws Exception {
        Path f = Files.createTempFile("probe-", ".bin");
        try {
            Files.writeString(f, "abc");
            // SHA-256("abc")
            assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", VideoProbe.sha256(f, null));
            double[] last = {0};
            VideoProbe.sha256(f, p -> last[0] = p);
            assertEquals(1.0, last[0], 1e-9);
        } finally {
            Files.deleteIfExists(f);
        }
    }
}
