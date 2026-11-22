/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.facility;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Locale;

/**
 * 施設の設定ファイルを文字列として読む。🔴 <b>実行しない・解釈するのは JSON だけ。</b>通常のファイル・拡張子 {@code .json}・
 * {@link #MAX_BYTES} まで・UTF-8（BOM 可）だけを読み、失敗は<b>理由のコードだけ</b>で返す（中身をエラーに入れない）。
 */
public final class FacilityConfigReader {

    private FacilityConfigReader() {
    }

    /** 読む大きさの上限。リンク 1 件を 300 バイトとして約 1,700 件分（項目の上限 2,000 件に近い余裕）。 */
    public static final long MAX_BYTES = 512 * 1024;

    /** 読んだ結果。{@code text} か {@code error} のどちらか 1 つだけが入る。 */
    public record Result(String text, String error) {
        public boolean ok() {
            return text != null;
        }
    }

    /** 変化の検出に使う署名（大きさ＋更新時刻）。 */
    public static String signature(Path file) throws IOException {
        BasicFileAttributes a = Files.readAttributes(file, BasicFileAttributes.class);
        return a.size() + ":" + a.lastModifiedTime().toMillis();
    }

    public static Result read(Path file) {
        try {
            if (!Files.isRegularFile(file)) {
                return err("not-a-file");
            }
            if (!file.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".json")) {
                return err("extension-not-allowed");
            }
            if (Files.size(file) > MAX_BYTES) {
                return err("file-too-large");
            }
            byte[] raw = Files.readAllBytes(file);
            if (raw.length > MAX_BYTES) { // 読む間に大きくなった場合
                return err("file-too-large");
            }
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(raw)).toString();
            if (!text.isEmpty() && text.charAt(0) == '﻿') {
                text = text.substring(1);
            }
            return new Result(text, null);
        } catch (CharacterCodingException e) {
            return err("decode-failed");
        } catch (IOException | RuntimeException e) {
            return err("read-failed");
        }
    }

    private static Result err(String code) {
        return new Result(null, code);
    }
}
