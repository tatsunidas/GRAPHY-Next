/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nondicom;

import com.vis.graphynext.nondicom.NonDicomImportService.FileOutcome;
import com.vis.graphynext.nondicom.NonDicomImportService.Request;
import com.vis.graphynext.nondicom.NonDicomImportService.Result;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 取込の堅牢性（NPE/不正入力耐性）を検証。storage を {@code null} で渡し、
 * <b>正常に DICOM 化できるファイルが無いケース</b>のみを対象にすることで、storage 未使用＝
 * 例外隔離が効いていることを担保する（1 件でも storage を呼べば NPE になるはず）。
 */
class NonDicomImportServiceTest {

    // ffmpeg は意図的に存在しないパスを注入 → 動画は常に「ffmpeg 必要」で skip（env 非依存・storage 未使用）。
    private final NonDicomImportService service =
            new NonDicomImportService(null, new FfmpegLocator("no-such-ffmpeg-binary-xyz", ""));

    @Test
    void nullRequest_returnsEmptyResultNotNpe() {
        Result r = service.importFiles(null);
        assertEquals(0, r.imported());
        assertEquals(0, r.failed());
        assertTrue(r.files().isEmpty());
    }

    @Test
    void nullPathsAndNullElements_areHandled() {
        Request req = new Request(
                Arrays.asList(null, "/no/such/file.png"),
                "PID-1", "name", null, null, null, null, null, "Imported");
        Result r = service.importFiles(req);
        // null 要素＝failed(invalid path)、存在しないファイル＝skipped(not a file)。NPE で落ちない。
        assertEquals(0, r.imported());
        assertEquals(2, r.files().size());
    }

    @Test
    void unsupportedAndUndecodable_areSkipped_withoutTouchingStorage() throws Exception {
        Path dir = Files.createTempDirectory("nondicom-robust-");
        Path mp4 = Files.write(dir.resolve("clip.mp4"), new byte[] {0});
        Path avi = Files.write(dir.resolve("clip.avi"), new byte[] {0});
        Path xyz = Files.write(dir.resolve("data.xyz"), new byte[] {0});
        Path png = Files.write(dir.resolve("broken.png"), new byte[] {1, 2, 3}); // 不正な画像 → decode 失敗
        try {
            Request req = new Request(
                    List.of(mp4.toString(), avi.toString(), xyz.toString(), png.toString()),
                    "PID-1", "name", null, null, null, null, null, "Imported");
            Result r = service.importFiles(req);
            // すべて skipped（imported=0 なので storage は一度も呼ばれない＝null でも NPE 無し）。
            assertEquals(0, r.imported());
            assertEquals(0, r.failed());
            assertEquals(4, r.skipped());
            // 動画(mp4/avi)は ffmpeg 不在＋非 H.264 のため skip（メッセージに ffmpeg を含む）
            for (String fn : new String[] {"clip.mp4", "clip.avi"}) {
                FileOutcome v = r.files().stream().filter(f -> f.filename().equals(fn)).findFirst().orElseThrow();
                assertEquals("skipped", v.status());
                assertTrue(v.message().toLowerCase().contains("ffmpeg"), fn + ": " + v.message());
            }
        } finally {
            try (var s = Files.walk(dir)) {
                s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            }
        }
    }
}
