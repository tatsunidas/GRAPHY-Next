/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * {@link HttpGitHubReleaseClient}: API ベース URL の検証。
 *
 * <p>ここから取得した配布物はアプリと同じ権限で動くコードを含み得るため、
 * 平文 HTTP や不正な URL は起動時に落とす（黙って動かさない）。
 */
class HttpGitHubReleaseClientTest {

    @Test
    void defaultsToPublicGitHubApi() {
        assertEquals("https://api.github.com", HttpGitHubReleaseClient.requireHttps(null));
        assertEquals("https://api.github.com", HttpGitHubReleaseClient.requireHttps("  "));
    }

    @Test
    void acceptsHttpsAndTrimsTrailingSlashes() {
        assertEquals("https://github.example.com/api/v3",
                HttpGitHubReleaseClient.requireHttps("https://github.example.com/api/v3"));
        assertEquals("https://github.example.com/api/v3",
                HttpGitHubReleaseClient.requireHttps(" https://github.example.com/api/v3// "));
    }

    @Test
    void rejectsPlainHttp() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> HttpGitHubReleaseClient.requireHttps("http://127.0.0.1:8099"));
        assertEquals(true, e.getMessage().contains("must be an https URL"), e.getMessage());
    }

    @Test
    void rejectsNonUrlAndSchemelessValues() {
        assertThrows(IllegalStateException.class, () -> HttpGitHubReleaseClient.requireHttps("api.github.com"));
        assertThrows(IllegalStateException.class, () -> HttpGitHubReleaseClient.requireHttps("file:///etc/passwd"));
        assertThrows(IllegalStateException.class, () -> HttpGitHubReleaseClient.requireHttps("https://"));
    }

    /**
     * 🔴 一時的な 5xx は自動で再試行すること。
     *
     * <p>2026-08-24、GitHub のエッジが返した<b>1 回きりの 504</b> でプラグインの導入全体が
     * 「取得に失敗しました: HTTP 504」で落ちた（直後に手で叩き直すと 200＝完全に一過性）。
     * 再試行が無いのは実装の不足なので、ここで固定する。
     */
    @Test
    void retriesTransientServerErrors() throws Exception {
        AtomicInteger hits = new AtomicInteger();
        try (Server s = Server.start(ex -> {
            int n = hits.incrementAndGet();
            byte[] body = n < 3 ? "gateway timeout".getBytes(StandardCharsets.UTF_8)
                                : "PAYLOAD".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(n < 3 ? 504 : 200, body.length);
            ex.getResponseBody().write(body);
            ex.close();
        })) {
            byte[] got = client().download(s.url(), null);
            assertEquals("PAYLOAD", new String(got, StandardCharsets.UTF_8));
            assertEquals(3, hits.get(), "504 を 2 回受けてから成功する");
        }
    }

    /** 404 は待っても変わらないので再試行しない（＋何を直せばよいか文言に出す）。 */
    @Test
    void doesNotRetryNotFound() throws Exception {
        AtomicInteger hits = new AtomicInteger();
        try (Server s = Server.start(ex -> {
            hits.incrementAndGet();
            ex.sendResponseHeaders(404, -1);
            ex.close();
        })) {
            PluginInstallException e = assertThrows(PluginInstallException.class,
                    () -> client().download(s.url(), null));
            assertEquals(1, hits.get(), "404 は 1 回で諦める");
            assertEquals(true, e.getMessage().contains("見つかりません"), e.getMessage());
        }
    }

    /** レート制限は残量ヘッダを見て、待つ／トークンを設定する、と伝える。 */
    @Test
    void explainsRateLimit() throws Exception {
        try (Server s = Server.start(ex -> {
            ex.getResponseHeaders().add("X-RateLimit-Remaining", "0");
            ex.sendResponseHeaders(403, -1);
            ex.close();
        })) {
            PluginInstallException e = assertThrows(PluginInstallException.class,
                    () -> client().download(s.url(), null));
            assertEquals(true, e.getMessage().contains("レート制限"), e.getMessage());
        }
    }

    private static HttpGitHubReleaseClient client() {
        return new HttpGitHubReleaseClient(new com.fasterxml.jackson.databind.ObjectMapper(), null);
    }

    /** テスト用の最小 HTTP サーバ（download() は URL を直接受けるので http で足りる）。 */
    private record Server(HttpServer http) implements AutoCloseable {
        static Server start(HttpHandler h) throws IOException {
            HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            s.createContext("/asset", h);
            s.start();
            return new Server(s);
        }

        String url() {
            return "http://127.0.0.1:" + http.getAddress().getPort() + "/asset";
        }

        @Override
        public void close() {
            http.stop(0);
        }
    }
}
