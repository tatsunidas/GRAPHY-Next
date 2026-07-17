/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nondicom;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 動画 DICOM 化の補助ロジック（ffmpeg 検出・非対応時の挙動）の検証。 */
class VideoConverterTest {

    @Test
    void ffmpegAvailable_falseForMissingBinary() {
        assertFalse(VideoConverter.ffmpegAvailable("no-such-ffmpeg-binary-xyz"));
    }

    @Test
    void transcodeCommand_disablesBFramesForFrameOrderGuarantee() {
        // 旧 GRAPHY (Java Swing) のフレーム順序バグ（B-frame ありで decode order != presentation order
        // となり再生時にフレームが入れ替わった）と同じ轍を踏まないよう、-bf 0 を必ず含めることを検証する。
        List<String> cmd = VideoConverter.transcodeCommand(
                "ffmpeg", Path.of("in.avi"), Path.of("out.mp4"));
        int bfIndex = cmd.indexOf("-bf");
        assertTrue(bfIndex >= 0, "ffmpeg コマンドに -bf が含まれること");
        assertTrue(bfIndex + 1 < cmd.size() && "0".equals(cmd.get(bfIndex + 1)),
                "-bf の直後の値が 0 であること（B-frame 無効化）");
    }

    @Test
    void nonH264OrAvi_withoutFfmpeg_throwsUnsupported() throws IOException {
        // H.264 でない MP4（ここではダミー）→ パース不可。ffmpeg 不在 → UnsupportedOperationException。
        Path mp4 = Files.createTempFile("vc-test-", ".mp4");
        Path avi = Files.createTempFile("vc-test-", ".avi");
        Path out = Files.createTempFile("vc-out-", ".dcm");
        Files.write(mp4, new byte[] {0, 0, 0, 0});
        Files.write(avi, new byte[] {0, 0, 0, 0});
        NonDicomConverter.Ctx ctx = new NonDicomConverter.Ctx(
                "P", "n", null, null, "1.2", "20260630", "120000", "d", "a",
                "1.2.1", 1, "v", "XC", 1);
        try {
            assertThrows(UnsupportedOperationException.class,
                    () -> VideoConverter.writeVideoDicom(ctx, mp4, out, "no-such-ffmpeg-binary-xyz"));
            assertThrows(UnsupportedOperationException.class,
                    () -> VideoConverter.writeVideoDicom(ctx, avi, out, "no-such-ffmpeg-binary-xyz"));
        } finally {
            Files.deleteIfExists(mp4);
            Files.deleteIfExists(avi);
            Files.deleteIfExists(out);
        }
    }
}
