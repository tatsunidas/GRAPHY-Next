/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * 1 回の実行に返ってくるメッセージを集めて {@link ExecutionResult} にする。
 *
 * <p>🔴 <b>終わりの判定は「shell の {@code execute_reply}」と「iopub の {@code status: idle}」の両方</b>。
 * 2 つは別のチャネルで届き、順序は保証されない。reply だけで終わらせると、その後に届く
 * stdout の最後の行を取りこぼす（idle は「この要求の出力はすべて出し終えた」の合図）。
 *
 * <p>出力が大きすぎるとメモリを食い潰すので、stdout / stderr / 出力の各合計に上限を置く。
 */
final class ExecutionCollector {

    /** stdout・stderr それぞれの上限（文字数）。超えた分は捨て、末尾に印を付ける。 */
    static final int MAX_STREAM_CHARS = 1_000_000;
    /** {@code execute_result} / {@code display_data} の合計上限（文字数。画像は base64 のまま数える）。 */
    static final int MAX_OUTPUT_CHARS = 32_000_000;
    static final String TRUNCATED = "\n…[truncated]";

    /** 出力が届くたびに呼ばれる（進み具合の表示用）。どのスレッドから呼ばれるかは決まっていない。 */
    interface Listener {
        void onStream(String name, String text);

        Listener NONE = (name, text) -> {
        };
    }

    private final String msgId;
    private final Listener listener;
    private final CompletableFuture<ExecutionResult> future = new CompletableFuture<>();

    private final StringBuilder stdout = new StringBuilder();
    private final StringBuilder stderr = new StringBuilder();
    private boolean stdoutTruncated;
    private boolean stderrTruncated;
    private final List<Map<String, String>> outputs = new ArrayList<>();
    private long outputChars;
    private String errorName;
    private String errorValue;
    private List<String> traceback = List.of();
    private String replyStatus;
    private Integer executionCount;
    private boolean idle;

    ExecutionCollector(String msgId, Listener listener) {
        this.msgId = msgId;
        this.listener = listener == null ? Listener.NONE : listener;
    }

    String msgId() {
        return msgId;
    }

    CompletableFuture<ExecutionResult> future() {
        return future;
    }

    /** 自分宛て（parent が自分の msg_id）のメッセージなら取り込んで true。 */
    boolean accept(JsonNode msg) {
        if (!msgId.equals(KernelMessages.parentMsgId(msg))) {
            return false;
        }
        JsonNode c = msg.path("content");
        String type = KernelMessages.msgType(msg);
        String streamName = null;
        String streamText = null;
        synchronized (this) {
            if (future.isDone()) {
                return true;
            }
            switch (type) {
                case "stream" -> {
                    streamName = c.path("name").asText("stdout");
                    streamText = c.path("text").asText("");
                    appendStream(streamName, streamText);
                }
                case "execute_result", "display_data" -> addOutput(c.path("data"));
                case "error" -> readError(c);
                case "execute_reply" -> {
                    replyStatus = c.path("status").asText("error");
                    if (c.hasNonNull("execution_count")) {
                        executionCount = c.get("execution_count").asInt();
                    }
                    if ("error".equals(replyStatus) && errorName == null) {
                        readError(c);
                    }
                }
                case "status" -> {
                    if ("idle".equals(c.path("execution_state").asText())) {
                        idle = true;
                    }
                }
                default -> {
                    // clear_output・execute_input などは使わない
                }
            }
            if (replyStatus != null && idle) {
                future.complete(build());
            }
        }
        if (streamText != null) {
            listener.onStream(streamName, streamText);
        }
        return true;
    }

    /** カーネルが落ちた・接続が切れたときなど。 */
    void fail(Throwable t) {
        future.completeExceptionally(t);
    }

    private void appendStream(String name, String text) {
        boolean err = "stderr".equals(name);
        StringBuilder sb = err ? stderr : stdout;
        if (err ? stderrTruncated : stdoutTruncated) {
            return;
        }
        int room = MAX_STREAM_CHARS - sb.length();
        if (text.length() <= room) {
            sb.append(text);
            return;
        }
        sb.append(text, 0, Math.max(room, 0)).append(TRUNCATED);
        if (err) {
            stderrTruncated = true;
        } else {
            stdoutTruncated = true;
        }
    }

    private void addOutput(JsonNode data) {
        Map<String, String> m = new LinkedHashMap<>();
        long size = 0;
        for (Iterator<Map.Entry<String, JsonNode>> it = data.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            JsonNode v = e.getValue();
            String s = v.isTextual() ? v.asText()
                    : v.isArray() && allText(v) ? join(v) // 複数行の text/plain が配列で来ることがある
                    : v.toString();
            m.put(e.getKey(), s);
            size += s.length();
        }
        if (outputChars + size > MAX_OUTPUT_CHARS) {
            appendStream("stderr", "[graphy] output dropped: too large (" + size + " chars)\n");
            return;
        }
        outputChars += size;
        outputs.add(m);
    }

    private void readError(JsonNode c) {
        errorName = c.path("ename").asText(null);
        errorValue = c.path("evalue").asText(null);
        List<String> tb = new ArrayList<>();
        for (JsonNode line : c.path("traceback")) {
            tb.add(KernelMessages.stripAnsi(line.asText()));
        }
        traceback = List.copyOf(tb);
    }

    private ExecutionResult build() {
        return new ExecutionResult(replyStatus, stdout.toString(), stderr.toString(), List.copyOf(outputs),
                errorName, errorValue, traceback, executionCount);
    }

    private static boolean allText(JsonNode arr) {
        for (JsonNode n : arr) {
            if (!n.isTextual()) {
                return false;
            }
        }
        return true;
    }

    private static String join(JsonNode arr) {
        StringBuilder sb = new StringBuilder();
        for (JsonNode n : arr) {
            sb.append(n.asText());
        }
        return sb.toString();
    }
}
