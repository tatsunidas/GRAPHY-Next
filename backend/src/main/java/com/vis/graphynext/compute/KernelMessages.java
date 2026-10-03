/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Jupyter のメッセージ（プロトコル v5.3）を JSON で組み立てる・読む。
 *
 * <p>WebSocket は <b>サブプロトコル無しの JSON テキストフレーム</b>で話す。jupyter_server は
 * サブプロトコルを名乗らないクライアントにはこの形で返す（Colab のランタイムも同じ Jupyter Server）。
 * 1 つのメッセージは {@code header / parent_header / metadata / content / channel / buffers}。
 */
final class KernelMessages {

    static final String PROTOCOL_VERSION = "5.3";
    private static final Pattern ANSI = Pattern.compile("\u001B\\[[0-9;]*[A-Za-z]");

    private KernelMessages() {
    }

    static ObjectNode request(ObjectMapper mapper, String session, String msgType, String channel,
                              ObjectNode content) {
        ObjectNode header = mapper.createObjectNode()
                .put("msg_id", UUID.randomUUID().toString())
                .put("username", "graphy-next")
                .put("session", session)
                .put("date", OffsetDateTime.now(ZoneOffset.UTC).toString())
                .put("msg_type", msgType)
                .put("version", PROTOCOL_VERSION);
        ObjectNode msg = mapper.createObjectNode();
        msg.set("header", header);
        msg.set("parent_header", mapper.createObjectNode());
        msg.set("metadata", mapper.createObjectNode());
        msg.set("content", content);
        msg.put("channel", channel);
        msg.set("buffers", mapper.createArrayNode());
        return msg;
    }

    /**
     * {@code execute_request}。履歴に残さず（{@code store_history=false}）、入力待ちは許さない
     * （{@code allow_stdin=false}：{@code input()} はすぐ例外になる。返事をする人がいないため）。
     */
    static ObjectNode executeRequest(ObjectMapper mapper, String session, String code) {
        ObjectNode content = mapper.createObjectNode()
                .put("code", code)
                .put("silent", false)
                .put("store_history", false)
                .put("allow_stdin", false)
                .put("stop_on_error", true);
        content.set("user_expressions", mapper.createObjectNode());
        return request(mapper, session, "execute_request", "shell", content);
    }

    static ObjectNode kernelInfoRequest(ObjectMapper mapper, String session) {
        return request(mapper, session, "kernel_info_request", "shell", mapper.createObjectNode());
    }

    static String msgId(JsonNode msg) {
        return msg.path("header").path("msg_id").asText(null);
    }

    static String msgType(JsonNode msg) {
        return msg.path("header").path("msg_type").asText("");
    }

    static String parentMsgId(JsonNode msg) {
        return msg.path("parent_header").path("msg_id").asText(null);
    }

    /** トレースバックの ANSI 色指定を外す（画面・ログにそのまま出すため）。 */
    static String stripAnsi(String s) {
        return s == null ? null : ANSI.matcher(s).replaceAll("");
    }
}
