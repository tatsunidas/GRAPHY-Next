/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VideoFragmentExtractorTest {

    @TempDir
    Path tmp;

    @Test
    void extractTo_concatenatesFragmentsSkippingBot() throws IOException {
        byte[] a = "MP4ATOMS".getBytes(StandardCharsets.US_ASCII); // 8 (even)
        byte[] b = "0123".getBytes(StandardCharsets.US_ASCII);     // 4 (even)
        Path dcm = VideoTestDicoms.writeVideoDicom(tmp, UID.MPEG4HP41, 480, 640, 30, 33.3, a, b);

        Path out = Files.createTempFile(tmp, "out-", ".mp4");
        long n = VideoFragmentExtractor.extractTo(dcm, out);

        byte[] expected = new byte[a.length + b.length];
        System.arraycopy(a, 0, expected, 0, a.length);
        System.arraycopy(b, 0, expected, a.length, b.length);
        assertArrayEquals(expected, Files.readAllBytes(out), "BOT を飛ばしフラグメントを連結");
        assertEquals(expected.length, n);
    }

    @Test
    void readInfo_returnsGeometryAndTransferSyntax() throws IOException {
        Path dcm = VideoTestDicoms.writeVideoDicom(tmp, UID.MPEG4HP41, 480, 640, 30, 40.0,
                "x".getBytes(StandardCharsets.US_ASCII));
        VideoFragmentExtractor.VideoInfo info = VideoFragmentExtractor.readInfo(dcm);

        assertEquals(480, info.rows());
        assertEquals(640, info.columns());
        assertEquals(30, info.numberOfFrames());
        assertEquals(40.0, info.frameTimeMs(), 0.001);
        assertEquals(UID.MPEG4HP41, info.transferSyntaxUid());
        assertTrue(info.playable(), "H.264 High は無変換再生可");
        assertEquals(25.0, info.fps(), 0.001, "fps = 1000/FrameTime");
    }

    @Test
    void mpeg2_isNotBrowserPlayable() throws IOException {
        Path dcm = VideoTestDicoms.writeVideoDicom(tmp, UID.MPEG2MPML, 480, 640, 30, 33.3,
                "x".getBytes(StandardCharsets.US_ASCII));
        assertFalse(VideoFragmentExtractor.readInfo(dcm).playable(), "MPEG2 は要 ffmpeg（P4）");
    }
}
