/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 1 つのカーネルへの WebSocket（{@code /api/kernels/{id}/channels}）。
 *
 * <p>shell・iopub・control の 3 チャネルが 1 本の WebSocket に多重化されて届く
 * （各メッセージの {@code channel} で区別）。返事は {@code parent_header.msg_id} で
 * 要求に振り分ける。
 *
 * <p>同時に複数の {@link #execute} を投げてよいが、カーネルは 1 つずつ順に実行する。
 */
public final class KernelChannel implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(KernelChannel.class);
    /** 1 メッセージの上限（文字数）。これを超えるフレームの連なりは捨てて接続を切る。 */
    static final int MAX_MESSAGE_CHARS = 64_000_000;

    private final ObjectMapper mapper;
    private final String session = UUID.randomUUID().toString();
    private final Map<String, ExecutionCollector> executions = new ConcurrentHashMap<>();
    private final Map<String, CompletableFuture<JsonNode>> replies = new ConcurrentHashMap<>();
    private final CompletableFuture<Void> closed = new CompletableFuture<>();
    private volatile WebSocket ws;

    private KernelChannel(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    /** WebSocket を開く。カーネルの準備ができたかは {@link #awaitReady} で確かめる。 */
    static KernelChannel open(HttpClient http, ObjectMapper mapper, JupyterEndpoint ep, String kernelId,
                              Duration timeout) {
        KernelChannel ch = new KernelChannel(mapper);
        WebSocket.Builder b = http.newWebSocketBuilder().connectTimeout(timeout);
        ep.headers().forEach(b::header);
        try {
            ch.ws = b.buildAsync(ep.kernelChannels(kernelId, ch.session), ch.new Receiver())
                    .get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new JupyterException("interrupted while connecting to kernel", e);
        } catch (ExecutionException | TimeoutException e) {
            Throwable c = e instanceof ExecutionException ? e.getCause() : e;
            throw new JupyterException("cannot open kernel channel: " + c, c);
        }
        return ch;
    }

    /**
     * カーネルが応答するまで {@code kernel_info_request} を送り直して待つ。
     * 起動直後のカーネルは最初の要求を落とすことがあるため（Jupyter の推奨どおり、返事が来るまで繰り返す）。
     *
     * @return {@code kernel_info_reply} の content（言語・バージョン等）
     */
    public JsonNode awaitReady(Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (true) {
            long left = deadline - System.nanoTime();
            if (left <= 0) {
                throw new JupyterException("kernel did not become ready within " + timeout, 0);
            }
            ObjectNode req = KernelMessages.kernelInfoRequest(mapper, session);
            CompletableFuture<JsonNode> f = new CompletableFuture<>();
            String id = KernelMessages.msgId(req);
            replies.put(id, f);
            try {
                send(req);
                return f.get(Math.min(TimeUnit.NANOSECONDS.toMillis(left), 2000), TimeUnit.MILLISECONDS)
                        .path("content");
            } catch (TimeoutException e) {
                // もう一度送る
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new JupyterException("interrupted while waiting for kernel", e);
            } catch (ExecutionException e) {
                throw new JupyterException("kernel channel failed: " + e.getCause(), e.getCause());
            } finally {
                replies.remove(id);
            }
        }
    }

    /**
     * コードを実行する。返る future は出力をすべて受け取ってから完了する。
     * 時間切れの扱い（{@code interrupt} するか）は呼び出し側が決める。
     */
    public CompletableFuture<ExecutionResult> execute(String code, ExecutionCollector.Listener listener) {
        ObjectNode req = KernelMessages.executeRequest(mapper, session, code);
        ExecutionCollector col = new ExecutionCollector(KernelMessages.msgId(req), listener);
        executions.put(col.msgId(), col);
        col.future().whenComplete((r, t) -> executions.remove(col.msgId()));
        if (closed.isDone()) {
            col.fail(new JupyterException("kernel channel is closed", 0));
            return col.future();
        }
        try {
            send(req);
        } catch (RuntimeException e) {
            col.fail(e);
        }
        return col.future();
    }

    public boolean isOpen() {
        return !closed.isDone();
    }

    @Override
    public void close() {
        WebSocket w = ws;
        if (w != null && !w.isOutputClosed()) {
            try {
                w.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(2, TimeUnit.SECONDS);
            } catch (Exception e) {
                w.abort();
            }
        }
        failAll(new JupyterException("kernel channel closed", 0));
    }

    /** WebSocket の送信は前の送信が終わるまで次を出せないので直列にする。 */
    private synchronized void send(ObjectNode msg) {
        try {
            ws.sendText(mapper.writeValueAsString(msg), true).join();
        } catch (IOException | CompletionException e) {
            throw new JupyterException("cannot send to kernel: " + e.getMessage(), e);
        }
    }

    private void dispatch(String text) {
        JsonNode msg;
        try {
            msg = mapper.readTree(text);
        } catch (IOException e) {
            log.warn("ignoring unparsable kernel message ({} chars)", text.length());
            return;
        }
        String parent = KernelMessages.parentMsgId(msg);
        if (parent == null) {
            return;
        }
        ExecutionCollector col = executions.get(parent);
        if (col != null) {
            col.accept(msg);
            return;
        }
        CompletableFuture<JsonNode> f = replies.get(parent);
        if (f != null && KernelMessages.msgType(msg).endsWith("_reply")) {
            f.complete(msg);
        }
    }

    private void failAll(Throwable t) {
        closed.complete(null);
        executions.values().forEach(c -> c.fail(t));
        replies.values().forEach(f -> f.completeExceptionally(t));
    }

    private final class Receiver implements WebSocket.Listener {
        private final StringBuilder buf = new StringBuilder();
        private boolean overflow;

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            if (!overflow) {
                if (buf.length() + data.length() > MAX_MESSAGE_CHARS) {
                    overflow = true;
                    buf.setLength(0);
                } else {
                    buf.append(data);
                }
            }
            if (last) {
                if (overflow) {
                    log.warn("kernel message exceeded {} chars; closing channel", MAX_MESSAGE_CHARS);
                    webSocket.abort();
                    failAll(new JupyterException("kernel message too large", 0));
                    return null;
                }
                String text = buf.toString();
                buf.setLength(0);
                dispatch(text);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, java.nio.ByteBuffer data, boolean last) {
            webSocket.request(1); // サブプロトコルを名乗っていないので来ない想定。来ても使わない
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            failAll(new JupyterException("kernel channel closed by server (" + statusCode + " " + reason + ")", 0));
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            failAll(new JupyterException("kernel channel error: " + error, error));
        }
    }
}
