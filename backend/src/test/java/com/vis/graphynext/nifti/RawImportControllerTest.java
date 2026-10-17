/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

/** Raw 取り込みの入口でのサイズの検査（変換の前に止める・余りを返す）。 */
class RawImportControllerTest {

    /** 変換まで進んだかを数えるだけの取り込み役。 */
    private static final class CountingService extends NiftiImportService {
        int calls;

        CountingService() {
            super(null);
        }

        @Override
        public Result importRaw(Path data, NiftiHeader header, NiftiToDicom.Options opts) {
            calls++;
            return new Result(1, 0, 1, 1, 1, 2, 2, "sform", false, "1.2", "1.3", 0, "int16", null, null);
        }
    }

    private static RawImportController.ImportRequest req(Path f, int slices) {
        return new RawImportController.ImportRequest(f.toString(),
                new RawSpec(2, 2, slices, 1, "int16", "little", 4, new double[] { 1, 1, 1 }, "axial", null),
                "CT", null, null, null, null, null, null, null, null, null, null);
    }

    @Test
    void 足りなければ変換せずに400で必要量とファイルの大きさを返す() throws IOException {
        Path f = Files.createTempFile("raw", ".raw");
        Files.write(f, new byte[4 + 2 * 2 * 2 * 2 - 1]); // 2 枚に 1 バイト足りない
        CountingService svc = new CountingService();
        ResponseEntity<RawImportController.ImportResponse> r = new RawImportController(svc).importRaw(req(f, 2));
        assertThat(r.getStatusCode().value()).isEqualTo(400);
        assertThat(r.getBody().requiredBytes()).isEqualTo(20);
        assertThat(r.getBody().fileBytes()).isEqualTo(19);
        assertThat(r.getBody().error()).contains("足りません");
        assertThat(svc.calls).isZero();
    }

    @Test
    void ちょうどなら余り0で取り込み_多ければ余りを返す() throws IOException {
        Path f = Files.createTempFile("raw", ".raw");
        Files.write(f, new byte[20]);
        CountingService svc = new CountingService();
        ResponseEntity<RawImportController.ImportResponse> r = new RawImportController(svc).importRaw(req(f, 2));
        assertThat(r.getStatusCode().value()).isEqualTo(200);
        assertThat(r.getBody().trailingBytes()).isZero();

        Files.write(f, new byte[27]);
        r = new RawImportController(svc).importRaw(req(f, 2));
        assertThat(r.getBody().trailingBytes()).isEqualTo(7);
        assertThat(svc.calls).isEqualTo(2);
    }

    @Test
    void 申告の誤りとファイル無しは400() throws IOException {
        CountingService svc = new CountingService();
        RawImportController c = new RawImportController(svc);
        Path f = Files.createTempFile("raw", ".raw");
        Files.write(f, new byte[100]);
        RawImportController.ImportRequest bad = new RawImportController.ImportRequest(f.toString(),
                new RawSpec(2, 2, 2, 1, "int12", "little", 0, new double[] { 1, 1, 1 }, "axial", null),
                null, null, null, null, null, null, null, null, null, null, null);
        assertThat(c.importRaw(bad).getStatusCode().value()).isEqualTo(400);
        assertThat(c.importRaw(req(f.resolveSibling("missing-" + System.nanoTime()), 1)).getStatusCode().value()).isEqualTo(400);
        assertThat(svc.calls).isZero();
    }
}
