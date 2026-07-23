/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link ExportService#copyPortableViewer} が classpath の portable-viewer/** を
 * ZIP の VIEWER/ 以下へ相対パスを保って書き出すことを検証。
 * テスト用フィクスチャ = src/test/resources/portable-viewer/（index.html + assets/app.js）。
 * 実際の frontend/portable-dist ビルドには依存しない（成果物が無い CI でも通る）。
 */
class ExportPortableViewerTest {

    @Test
    void copiesPortableViewerFilesUnderViewerPrefix() throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(baos)) {
            ExportService.copyPortableViewer(zip);
        }

        Set<String> entries = new HashSet<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(baos.toByteArray()))) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                entries.add(e.getName());
                in.closeEntry();
            }
        }

        assertTrue(entries.contains("VIEWER/index.html"), "VIEWER/index.html が同梱されること: " + entries);
        assertTrue(entries.contains("VIEWER/assets/app.js"),
                "サブフォルダの相対パスが保たれること: " + entries);
        // VIEWER/ 以外の混入が無いこと（相対パス起点が正しいこと）。
        for (String name : entries) {
            assertTrue(name.startsWith("VIEWER/"), "全エントリが VIEWER/ 配下: " + name);
        }
        assertEquals(2, entries.size(), "フィクスチャの 2 ファイルのみ: " + entries);
    }
}
