/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.function.Supplier;

/**
 * refresh token からアクセストークンを得て、期限までは使い回す。backend が自分で更新する
 * （長時間のアップロード中の失効・オフライン復帰に、main への往復なしで追従するため）。
 */
public class GdriveTokenSource {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final HttpClient http;
    private final String tokenUrl;
    private final Supplier<GdriveConfig> config;
    private final java.time.Clock clock;
    private String cached;
    private long expiresAtMs;

    public GdriveTokenSource(HttpClient http, String tokenUrl, Supplier<GdriveConfig> config, java.time.Clock clock) {
        this.http = http;
        this.tokenUrl = tokenUrl;
        this.config = config;
        this.clock = clock;
    }

    public synchronized String accessToken() throws GdriveException {
        if (cached != null && clock.millis() < expiresAtMs) {
            return cached;
        }
        GdriveConfig c = config.get();
        if (c == null) {
            throw new GdriveException(GdriveException.Kind.FATAL, 0, "not-configured");
        }
        if (c.refreshToken() == null || c.refreshToken().isBlank()) {
            throw new GdriveException(GdriveException.Kind.RELOGIN, 0, "no-refresh-token");
        }
        StringBuilder form = new StringBuilder("grant_type=refresh_token");
        form.append("&client_id=").append(enc(c.clientId()));
        if (c.clientSecret() != null && !c.clientSecret().isEmpty()) {
            form.append("&client_secret=").append(enc(c.clientSecret()));
        }
        form.append("&refresh_token=").append(enc(c.refreshToken()));
        HttpRequest req = HttpRequest.newBuilder(URI.create(tokenUrl))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form.toString())).build();
        HttpResponse<String> r;
        try {
            r = http.send(req, HttpResponse.BodyHandlers.ofString());
        } catch (IOException e) {
            throw new GdriveException(GdriveException.Kind.OFFLINE, "token-endpoint-unreachable", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new GdriveException(GdriveException.Kind.OFFLINE, "interrupted", e);
        }
        if (r.statusCode() == 200) {
            try {
                JsonNode n = JSON.readTree(r.body());
                cached = n.path("access_token").asText(null);
                long ttl = n.path("expires_in").asLong(3600);
                expiresAtMs = clock.millis() + Math.max(60, ttl - 60) * 1000;
                if (cached == null) {
                    throw new GdriveException(GdriveException.Kind.RETRY, r.statusCode(), "token-response-invalid");
                }
                return cached;
            } catch (IOException e) {
                throw new GdriveException(GdriveException.Kind.RETRY, "token-response-invalid", e);
            }
        }
        // 🔴 本文（エラー説明）は出すが、トークン・secret は送った側にしか無いので漏れない
        String err = "";
        try {
            err = JSON.readTree(r.body()).path("error").asText("");
        } catch (IOException ignore) {
            // 本文が JSON でなければ status だけで判断する
        }
        if (r.statusCode() == 400 || r.statusCode() == 401) {
            if ("invalid_grant".equals(err) || "invalid_client".equals(err) || "unauthorized_client".equals(err)) {
                throw new GdriveException(GdriveException.Kind.RELOGIN, r.statusCode(), err);
            }
            throw new GdriveException(GdriveException.Kind.FATAL, r.statusCode(), "token-" + err);
        }
        throw new GdriveException(GdriveException.Kind.RETRY, r.statusCode(), "token-http-" + r.statusCode());
    }

    /** 401 を受けたとき（取り消し・時計のずれ）。次の呼び出しで取り直す。 */
    public synchronized void invalidate() {
        cached = null;
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
