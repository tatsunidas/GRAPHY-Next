/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.facility;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** ファイルの読み取り: 通常ファイル・.json・上限・UTF-8 だけ。失敗は理由のコードだけ。 */
class FacilityConfigReaderTest {

    @TempDir
    Path tmp;

    @Test
    void UTF8のJSONが読め_BOMは取り除かれる() throws IOException {
        Path f = tmp.resolve("c.json");
        Files.write(f, ("﻿{\"a\":\"日本語\"}").getBytes(StandardCharsets.UTF_8));
        FacilityConfigReader.Result r = FacilityConfigReader.read(f);
        assertTrue(r.ok());
        assertEquals("{\"a\":\"日本語\"}", r.text());
    }

    @Test
    void 拡張子_ディレクトリ_存在しない_は理由のコード() throws IOException {
        Path txt = tmp.resolve("c.txt");
        Files.writeString(txt, "{}");
        assertEquals("extension-not-allowed", FacilityConfigReader.read(txt).error());
        assertEquals("not-a-file", FacilityConfigReader.read(tmp).error());
        assertEquals("not-a-file", FacilityConfigReader.read(tmp.resolve("nope.json")).error());
    }

    @Test
    void 上限ちょうどは読め_1バイト超えると読まない() throws IOException {
        Path f = tmp.resolve("big.json");
        byte[] ok = new byte[(int) FacilityConfigReader.MAX_BYTES];
        java.util.Arrays.fill(ok, (byte) ' ');
        Files.write(f, ok);
        assertTrue(FacilityConfigReader.read(f).ok());
        byte[] over = new byte[(int) FacilityConfigReader.MAX_BYTES + 1];
        java.util.Arrays.fill(over, (byte) ' ');
        Files.write(f, over);
        assertEquals("file-too-large", FacilityConfigReader.read(f).error());
    }

    @Test
    void UTF8として不正な並びは_decode_failed() throws IOException {
        Path f = tmp.resolve("sjis.json");
        Files.write(f, "{\"a\":\"日本語\"}".getBytes(Charset.forName("windows-31j")));
        assertEquals("decode-failed", FacilityConfigReader.read(f).error());
    }

    @Test
    void 署名は大きさと更新時刻で変わる() throws IOException {
        Path f = tmp.resolve("s.json");
        Files.writeString(f, "{}");
        String a = FacilityConfigReader.signature(f);
        Files.writeString(f, "{ }");
        assertTrue(!a.equals(FacilityConfigReader.signature(f)));
    }
}
