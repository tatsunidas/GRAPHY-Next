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
import static org.junit.jupiter.api.Assertions.assertThrows;
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
        // VIEWER/ 以外に置くのは、媒体のルートの起動ファイルだけ（相対パス起点が正しいこと）。
        for (String name : entries) {
            assertTrue(name.startsWith("VIEWER/") || java.util.Arrays.asList(ExportService.LAUNCHER_ROOT_FILES).contains(name),
                    "VIEWER/ 配下か、ルートの起動ファイルだけ: " + name);
        }
        for (String f : ExportService.LAUNCHER_ROOT_FILES) {
            assertTrue(entries.contains(f), "起動ファイルがルートに入る: " + f);
        }
        for (String f : ExportService.LAUNCHER_VIEWER_FILES) {
            assertTrue(entries.contains("VIEWER/" + f), "サーバ本体が VIEWER/ に入る: " + f);
        }
        // ⚠ 件数は固定しない。**実 portable-viewer ビルドが classpath にあるかで変わる**ため
        // （target/classes/portable-viewer が有る＝make build 後は 12 件、無い＝-Dfrontend.skip では
        //  フィクスチャの 2 件）。以前ここを 2 件固定にしていたせいで、実成果物がある環境では必ず落ちていた。
        assertTrue(entries.size() >= 2, "少なくともフィクスチャ 2 件は入る: " + entries);
    }

    /** 起動スクリプトは OS ごとの改行・BOM が要る（崩れると起動しない／文字化けする）。 */
    @Test
    void launcherFilesKeepTheirLineEndingsAndBom() throws Exception {
        java.util.Map<String, byte[]> files = new java.util.HashMap<>();
        ExportService.Sink sink = new ExportService.Sink() {
            @Override
            public void put(String name, java.io.InputStream in) throws java.io.IOException {
                files.put(name, in.readAllBytes());
            }

            @Override
            public void close() {
            }
        };
        ExportService.copyPortableLauncher(sink);
        String bat = new String(files.get("START-VIEWER.bat"), java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(bat.contains("\r\n") && !bat.replace("\r\n", "").contains("\n"), ".bat は CRLF だけ");
        for (String sh : new String[] {"START-VIEWER.sh", "START-VIEWER.command", "VIEWER/serve.pl"}) {
            String t = new String(files.get(sh), java.nio.charset.StandardCharsets.UTF_8);
            assertTrue(!t.contains("\r"), sh + " は LF だけ（CR があると sh/perl が起動しない）");
        }
        byte[] ps1 = files.get("VIEWER/serve.ps1");
        assertTrue(ps1.length > 3 && (ps1[0] & 0xff) == 0xEF && (ps1[1] & 0xff) == 0xBB && (ps1[2] & 0xff) == 0xBF,
                "serve.ps1 は BOM 付き UTF-8（Windows PowerShell 5.1 が日本語を cp932 と読まない）");
        assertTrue(new String(files.get("START-VIEWER.sh"), java.nio.charset.StandardCharsets.UTF_8).startsWith("#!/bin/sh"));
    }

    /** 同梱を頼まれたのに成果物が無いとき、黙って省かず失敗させる（実機で「同梱したのに無い」媒体になった）。 */
    @Test
    void failsLoudlyWhenTheViewerBundleIsMissing() {
        java.util.Map<String, byte[]> files = new java.util.HashMap<>();
        ExportService.Sink sink = new ExportService.Sink() {
            @Override
            public void put(String name, java.io.InputStream in) throws java.io.IOException {
                files.put(name, in.readAllBytes());
            }

            @Override
            public void close() {
            }
        };
        java.io.IOException e = assertThrows(java.io.IOException.class,
                () -> ExportService.copyPortableViewer(sink, "classpath*:/no-such-viewer-dir/**"));
        assertTrue(e.getMessage().contains("portable"), e.getMessage());
        assertTrue(files.isEmpty(), "失敗時に中途半端な同梱を書かない");
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
