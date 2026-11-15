/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import com.vis.graphynext.importer.ImportWatchCsv;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 電子カルテが書き出すファイル（CSV か bat）から、「いま開いている患者の ID」を 1 つ読み取る（純関数＋ファイル読み）。
 *
 * <p>🔴 <b>ファイルは実行しない。文字列として読むだけ。</b>中身は信用しない: 通常のファイル・{@link #MAX_BYTES} まで・
 * 許可した拡張子だけを読み、ID として使うのは検証を通した 1 つのトークンだけ。<b>失敗の理由はコードで返し、
 * ファイルの中身（患者 ID を含む）をエラーやログに入れない。</b>
 */
public final class EmrFileReader {

    private EmrFileReader() {
    }

    /** 読む大きさの上限。ID を 1 つ書くだけのファイルなので小さくてよい。 */
    public static final long MAX_BYTES = 64 * 1024;
    /** 許可する拡張子（小文字）。 */
    static final List<String> EXTENSIONS = List.of(".csv", ".bat", ".cmd", ".txt");

    /** ID として許す形: 1〜64 文字、制御文字・空白の混じりなし、コマンドの区切りになる記号なし。 */
    private static final Pattern ID = Pattern.compile("^[^\\p{Cntrl}\\s&|<>^%\"]{1,64}$");
    private static final Pattern BAT_SET = Pattern.compile(
            "^\\s*@?\\s*set\\s+(?:/[pa]\\s+)?\"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)\"?\\s*$", Pattern.CASE_INSENSITIVE);

    /** 読んだ結果。{@code patientId} か {@code error} のどちらか 1 つだけが入る。 */
    public record Result(String patientId, String error) {
        public boolean ok() {
            return patientId != null;
        }
    }

    /** 監視の対象のファイルを決める。ファイルならそれ、フォルダなら更新が最も新しい許可拡張子のファイル。 */
    public static Optional<Path> resolve(String path) throws IOException {
        Path p = Path.of(path);
        if (Files.isDirectory(p)) {
            try (Stream<Path> s = Files.list(p)) {
                return s.filter(Files::isRegularFile).filter(EmrFileReader::allowedExtension)
                        .max((a, b) -> Long.compare(mtime(a), mtime(b)));
            }
        }
        return Files.exists(p) ? Optional.of(p) : Optional.empty();
    }

    private static long mtime(Path p) {
        try {
            return Files.getLastModifiedTime(p).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    static boolean allowedExtension(Path p) {
        String n = p.getFileName().toString().toLowerCase(Locale.ROOT);
        return EXTENSIONS.stream().anyMatch(n::endsWith);
    }

    /** 変化の検出に使う署名（大きさ＋更新時刻）。 */
    public static String signature(Path file) throws IOException {
        BasicFileAttributes a = Files.readAttributes(file, BasicFileAttributes.class);
        return a.size() + ":" + a.lastModifiedTime().toMillis();
    }

    /** ファイルを読んで ID を取り出す。 */
    public static Result read(EmrConfig cfg, Path file) {
        try {
            if (!Files.isRegularFile(file)) {
                return err("not-a-file");
            }
            if (!allowedExtension(file)) {
                return err("extension-not-allowed");
            }
            if (Files.size(file) > MAX_BYTES) {
                return err("file-too-large");
            }
            Charset cs = "Shift_JIS".equals(cfg.charset()) ? Charset.forName("windows-31j") : java.nio.charset.StandardCharsets.UTF_8;
            String text = decode(Files.readAllBytes(file), cs);
            return parse(cfg, file.getFileName().toString(), text);
        } catch (CharacterCodingException e) {
            return err("decode-failed");
        } catch (IOException e) {
            return err("read-failed");
        }
    }

    /** 文字列から ID を取り出す（純関数。{@code name} は拡張子で形式を決めるためだけに使う）。 */
    public static Result parse(EmrConfig cfg, String name, String text) {
        String fmt = cfg.format();
        if ("auto".equals(fmt)) {
            String n = name.toLowerCase(Locale.ROOT);
            fmt = n.endsWith(".bat") || n.endsWith(".cmd") ? "bat" : "csv";
        }
        return "bat".equals(fmt) ? parseBat(cfg.batVar(), text) : parseCsv(cfg.csvColumn(), cfg.csvHeader(), text);
    }

    static Result parseCsv(String column, boolean header, String text) {
        if (column == null) {
            return err("csv-column-required");
        }
        List<List<String>> rows = ImportWatchCsv.rows(text).stream()
                .filter(r -> r.stream().anyMatch(c -> !c.isBlank())).toList();
        if (rows.isEmpty()) {
            return err("empty");
        }
        int idx;
        List<List<String>> data = rows;
        Integer num = asIndex(column);
        if (header) {
            List<String> head = rows.get(0);
            idx = indexOfName(head, column);
            if (idx < 0 && num != null) {
                idx = num - 1;
            }
            data = rows.subList(1, rows.size());
        } else {
            if (num == null) {
                return err("csv-column-needs-number");
            }
            idx = num - 1;
        }
        if (idx < 0) {
            return err("column-not-found");
        }
        if (data.isEmpty()) {
            return err("empty");
        }
        List<String> last = data.get(data.size() - 1); // 最後の行が、いまの患者（追記でも上書きでも動く）
        if (idx >= last.size()) {
            return err("column-not-found");
        }
        return validate(last.get(idx));
    }

    static Result parseBat(String var, String text) {
        if (var == null) {
            return err("bat-var-required");
        }
        String value = null;
        for (String line : text.split("\\r?\\n")) {
            Matcher m = BAT_SET.matcher(line);
            if (m.matches() && m.group(1).equalsIgnoreCase(var)) {
                value = m.group(2); // 最後の出現
            }
        }
        if (value == null) {
            return err("var-not-found");
        }
        return validate(value);
    }

    /** ID の検証。通らなければ理由のコードだけ返す（値は返さない）。 */
    static Result validate(String raw) {
        if (raw != null && hasControl(raw)) {
            // String.trim() は末尾の NUL なども黙って削る。「1\0」を ID「1」として通さない
            return err("id-invalid");
        }
        String v = raw == null ? "" : raw.trim();
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            v = v.substring(1, v.length() - 1).trim();
        }
        if (v.isEmpty()) {
            return err("id-empty");
        }
        return ID.matcher(v).matches() ? new Result(v, null) : err("id-invalid");
    }

    /** 改行・タブ以外の制御文字を含むか（CSV のセルの前後に付く改行・タブは、あとで trim される）。 */
    private static boolean hasControl(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c < 0x20 && c != '\t' && c != '\r' && c != '\n') || c == 0x7f) {
                return true;
            }
        }
        return false;
    }

    private static Integer asIndex(String s) {
        try {
            int n = Integer.parseInt(s.trim());
            return n >= 1 ? n : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static int indexOfName(List<String> head, String name) {
        for (int i = 0; i < head.size(); i++) {
            if (stripBom(head.get(i)).trim().equals(name.trim())) {
                return i;
            }
        }
        return -1;
    }

    private static String stripBom(String s) {
        return s.startsWith("﻿") ? s.substring(1) : s;
    }

    private static String decode(byte[] bytes, Charset cs) throws CharacterCodingException {
        String s = cs.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        return stripBom(s);
    }

    private static Result err(String code) {
        return new Result(null, code);
    }
}
