/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class EmrFileReaderTest {

    @TempDir
    Path tmp;

    private static EmrConfig cfg(String format, String charset, String col, boolean header, String batVar) {
        return EmrConfig.from(Map.of(
                EmrConfig.KEY_ENABLED, "true", EmrConfig.KEY_PATH, "x", EmrConfig.KEY_FORMAT, format,
                EmrConfig.KEY_CHARSET, charset, EmrConfig.KEY_CSV_COLUMN, col == null ? "" : col,
                EmrConfig.KEY_CSV_HEADER, String.valueOf(header), EmrConfig.KEY_BAT_VAR, batVar == null ? "" : batVar,
                EmrConfig.KEY_PACS_AE, "PACS", EmrConfig.KEY_RETRIEVE, "move", EmrConfig.KEY_TIMEOUT, "60"));
    }

    private static void ok(String expected, EmrFileReader.Result r) {
        assertEquals(expected, r.patientId(), r.error());
        assertNull(r.error());
    }

    private static void ng(String code, EmrFileReader.Result r) {
        assertFalse(r.ok(), "読めてはいけない: " + r.patientId());
        assertEquals(code, r.error());
        assertNull(r.patientId());
    }

    @Test
    void csv_headerAndLastRow() {
        ok("P0002", EmrFileReader.parseCsv("患者ID", true, "患者ID,氏名\nP0001,山田\nP0002,鈴木\n"));
        ok("P0001", EmrFileReader.parseCsv("患者ID", true, "患者ID,氏名\r\nP0001,山田\r\n"));
        // 列は見出しの名前でも、1 から数えた番号でも指定できる
        ok("P0002", EmrFileReader.parseCsv("1", true, "患者ID,氏名\nP0001,山田\nP0002,鈴木\n"));
        ok("山田", EmrFileReader.parseCsv("氏名", true, "患者ID,氏名\nP0002,山田\n"));
        // BOM・引用符・空行
        ok("P0009", EmrFileReader.parseCsv("患者ID", true, "﻿患者ID,氏名\n\n\"P0009\",\"鈴木\"\n\n"));
    }

    @Test
    void csv_noHeader_needsNumber() {
        ok("123456", EmrFileReader.parseCsv("1", false, "123456\n"));
        ok("200", EmrFileReader.parseCsv("2", false, "a,100\nb,200\n"));
        ng("csv-column-needs-number", EmrFileReader.parseCsv("患者ID", false, "123\n"));
    }

    @Test
    void csv_errors() {
        ng("empty", EmrFileReader.parseCsv("患者ID", true, ""));
        ng("empty", EmrFileReader.parseCsv("患者ID", true, "患者ID,氏名\n")); // 見出しだけ
        ng("column-not-found", EmrFileReader.parseCsv("患者番号", true, "患者ID,氏名\nP1,山田\n"));
        ng("column-not-found", EmrFileReader.parseCsv("3", true, "患者ID,氏名\nP1,山田\n")); // 行より右の列
        ng("csv-column-required", EmrFileReader.parseCsv(null, true, "a\n1\n"));
    }

    @Test
    void bat_lastOccurrence_andForms() {
        ok("222", EmrFileReader.parseBat("PID", "@echo off\nset PID=111\nset PID=222\n"));
        ok("333", EmrFileReader.parseBat("pid", "SET \"PID=333\"\r\n")); // 変数名は大文字小文字を区別しない
        ok("444", EmrFileReader.parseBat("PID", "set PID=555\nset OTHER=1\n@set PID=444\n"));
        ok("A1", EmrFileReader.parseBat("PID", "rem set PID=ZZZ\nset PID=A1\n"));
        ng("var-not-found", EmrFileReader.parseBat("PID", "set OTHER=1\n"));
        ng("var-not-found", EmrFileReader.parseBat("PID", "rem set PID=1\n::set PID=2\n")); // コメントは読まない
        ng("bat-var-required", EmrFileReader.parseBat(null, "set PID=1\n"));
    }

    @Test
    void idValidation_negatives_neverEchoTheValue() {
        for (String bad : new String[] {"", "  ", "a b", "a&calc", "a|b", "1<2", "x^y", "%PATH%", "a\"b", "A".repeat(65)}) {
            EmrFileReader.Result r = EmrFileReader.validate(bad);
            assertFalse(r.ok(), "通ってはいけない: " + bad);
            assertTrue(List.of("id-empty", "id-invalid").contains(r.error()));
            assertNull(r.patientId()); // 値は返さない（ログ・エラーに患者 ID を出さない）
        }
        ok("12345", EmrFileReader.validate(" 12345 "));
        ok("12345", EmrFileReader.validate("\"12345\""));
        ok("A".repeat(64), EmrFileReader.validate("A".repeat(64)));
        ng("id-invalid", EmrFileReader.validate("1\u0000"));
        // bat に埋め込まれたコマンド連結は、ID として通らない（実行はしないが、通さない）
        ng("id-invalid", EmrFileReader.parseBat("PID", "set PID=1&calc.exe\n"));
    }

    @Test
    void read_decodesShiftJis_andRefusesBadEncoding() throws IOException {
        Charset sjis = Charset.forName("windows-31j");
        Path f = tmp.resolve("pid.csv");
        Files.write(f, "患者ID,氏名\nP0003,山田太郎\n".getBytes(sjis));
        ok("P0003", EmrFileReader.read(cfg("csv", "Shift_JIS", "患者ID", true, null), f));
        // UTF-8 のつもりで Shift_JIS を読むと、読めない（化けた値を ID にしない）
        ng("decode-failed", EmrFileReader.read(cfg("csv", "UTF-8", "患者ID", true, null), f));
        // 逆: Shift_JIS 指定で UTF-8 の日本語を読むと、化けるが、ID の列が ASCII なら ID は取れる場合がある → 化け文字は ID に通らない
        Path u = tmp.resolve("u.csv");
        Files.write(u, "氏名,患者ID\n山田,P0004\n".getBytes(StandardCharsets.UTF_8));
        EmrFileReader.Result r = EmrFileReader.read(cfg("csv", "Shift_JIS", "氏名", true, null), u);
        assertFalse(r.ok());
    }

    @Test
    void read_refusesUnsafeFiles() throws IOException {
        EmrConfig c = cfg("csv", "UTF-8", "1", false, null);
        Path big = tmp.resolve("big.csv");
        Files.write(big, new byte[(int) EmrFileReader.MAX_BYTES + 1]);
        ng("file-too-large", EmrFileReader.read(c, big));
        Path exe = tmp.resolve("a.exe");
        Files.writeString(exe, "123");
        ng("extension-not-allowed", EmrFileReader.read(c, exe));
        ng("not-a-file", EmrFileReader.read(c, tmp)); // フォルダ
        ng("not-a-file", EmrFileReader.read(c, tmp.resolve("nothing.csv")));
    }

    @Test
    void auto_format_followsTheExtension() {
        EmrConfig c = EmrConfig.from(Map.of(
                EmrConfig.KEY_ENABLED, "true", EmrConfig.KEY_PATH, "x", EmrConfig.KEY_FORMAT, "auto",
                EmrConfig.KEY_CHARSET, "UTF-8", EmrConfig.KEY_CSV_COLUMN, "1", EmrConfig.KEY_CSV_HEADER, "false",
                EmrConfig.KEY_BAT_VAR, "PID", EmrConfig.KEY_PACS_AE, "P", EmrConfig.KEY_RETRIEVE, "move",
                EmrConfig.KEY_TIMEOUT, "9"));
        assertTrue(c.valid(), String.valueOf(c.errors()));
        ok("77", EmrFileReader.parse(c, "x.bat", "set PID=77\n"));
        ok("78", EmrFileReader.parse(c, "x.CMD", "set PID=78\n"));
        ok("79", EmrFileReader.parse(c, "x.csv", "79\n"));
    }

    @Test
    void resolve_folderPicksTheNewestAllowedFile() throws Exception {
        Path a = tmp.resolve("a.csv");
        Path b = tmp.resolve("b.bat");
        Path c = tmp.resolve("c.exe");
        Files.writeString(a, "1");
        Files.writeString(b, "2");
        Files.writeString(c, "3");
        Files.setLastModifiedTime(a, java.nio.file.attribute.FileTime.fromMillis(1_000));
        Files.setLastModifiedTime(b, java.nio.file.attribute.FileTime.fromMillis(2_000));
        Files.setLastModifiedTime(c, java.nio.file.attribute.FileTime.fromMillis(3_000)); // 許可外は、新しくても選ばない
        assertEquals(b, EmrFileReader.resolve(tmp.toString()).orElseThrow());
        assertTrue(EmrFileReader.resolve(tmp.resolve("nope").toString()).isEmpty());
    }

    @Test
    void config_requiredItemsAreReported_andNoDefaults() {
        EmrConfig off = EmrConfig.from(Map.of());
        assertFalse(off.enabled());
        assertTrue(off.valid()); // 無効なら検証しない
        EmrConfig on = EmrConfig.from(Map.of(EmrConfig.KEY_ENABLED, "true"));
        assertFalse(on.valid());
        assertTrue(on.errors().containsAll(List.of("path-required", "format-required", "charset-required",
                "pacs-ae-required", "retrieve-required", "timeout-required")), String.valueOf(on.errors()));
        // csv を選んだら列が、bat を選んだら変数名が要る
        assertTrue(cfg("csv", "UTF-8", null, true, null).errors().contains("csv-column-required"));
        assertTrue(cfg("bat", "UTF-8", null, true, null).errors().contains("bat-var-required"));
        assertFalse(EmrConfig.from(Map.of(EmrConfig.KEY_YEARS, "0")).valid());
        assertFalse(EmrConfig.from(Map.of(EmrConfig.KEY_TIMEOUT, "abc")).valid());
    }
}
