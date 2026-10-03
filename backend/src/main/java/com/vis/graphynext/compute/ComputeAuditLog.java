/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;

/**
 * 外部の計算機への送信の監査ログ。設計: fw/remote-compute-design.md §6。
 *
 * <p>{@code <dataDir>/compute-audit.jsonl} に 1 出来事 1 行で<b>追記</b>する（backend の CWD＝データの置き場。
 * {@code ./plugins} {@code ./data/dicom} と同じ）。残すのは「いつ・どのプラグインが・どこへ・何を（ハッシュと
 * 大きさ）・どのコードで（ハッシュと先頭）」。🔴 <b>画素・患者情報・トークンは残さない。</b>
 *
 * <p>AI の送信はレンダラのログに 1 行出すだけだが、こちらは任意のコードが外で動くので、
 * 後から辿れるようにファイルへ残す。
 */
@Component
public class ComputeAuditLog {

    private static final Logger log = LoggerFactory.getLogger(ComputeAuditLog.class);
    /** コードの先頭として残す文字数（全文はハッシュで同定する）。 */
    static final int CODE_HEAD_CHARS = 200;

    private final Path file;
    private final ObjectMapper mapper;

    public ComputeAuditLog(@Value("${graphy.compute.audit-file:compute-audit.jsonl}") String file,
                           ObjectMapper mapper) {
        this.file = Path.of(file);
        this.mapper = mapper;
    }

    /** 新しい行の土台（時刻と出来事の名前入り）。呼び出し側が項目を足して {@link #append} に渡す。 */
    ObjectNode event(String type) {
        return mapper.createObjectNode().put("time", Instant.now().toString()).put("event", type);
    }

    /** 1 行足す。書けなくても処理は止めない（ログには残す）。 */
    synchronized void append(ObjectNode line) {
        try {
            Files.writeString(file, mapper.writeValueAsString(line) + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.error("[compute] 監査ログに書けません ({}): {}", file.toAbsolutePath(), e.getMessage());
        }
    }

    Path file() {
        return file;
    }

    static String codeHead(String code) {
        return code.length() <= CODE_HEAD_CHARS ? code : code.substring(0, CODE_HEAD_CHARS);
    }
}
