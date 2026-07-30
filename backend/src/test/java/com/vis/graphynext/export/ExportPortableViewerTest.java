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
        // ⚠ 件数は固定しない。**実 portable-viewer ビルドが classpath にあるかで変わる**ため
        // （target/classes/portable-viewer が有る＝make build 後は 12 件、無い＝-Dfrontend.skip では
        //  フィクスチャの 2 件）。以前ここを 2 件固定にしていたせいで、実成果物がある環境では必ず落ちていた。
        assertTrue(entries.size() >= 2, "少なくともフィクスチャ 2 件は入る: " + entries);
    }

    @Test
    void skipsDuplicateRelativePathsInsteadOfFailingTheWholeExport() throws Exception {
        // 実成果物（target/classes/portable-viewer）とテスト用フィクスチャ（target/test-classes/...）が
        // 同時に classpath にあると同じ相対パスが 2 回現れる。素直に書くと ZipException("duplicate entry")
        // で **Export 全体が落ちる**ので、重複は捨てて続行すること。
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(baos)) {
            ExportService.copyPortableViewer(zip); // 例外を投げないこと自体が検証
        }
        Set<String> entries = new HashSet<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(baos.toByteArray()))) {
            ZipEntry e;
            int guard = 0;
            while ((e = in.getNextEntry()) != null && guard++ < 10_000) {
                assertTrue(entries.add(e.getName()), "同じエントリを 2 回書かない: " + e.getName());
                in.closeEntry();
            }
        }
    }
}
