/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * {@link GitHubReleaseClient} の実装。JDK の {@code java.net.http.HttpClient} を使い、
 * 外部依存を足さない。CSP でレンダラは api.github.com を直接叩けないため、取得は必ず
 * このサーバ側経由で行う（update-notify 機能と同じ理由）。設計: fw/plugin-manager-design.md。
 */
@Component
public class HttpGitHubReleaseClient implements GitHubReleaseClient {

    private static final Logger log = LoggerFactory.getLogger(HttpGitHubReleaseClient.class);
    private static final String UA = "GRAPHY-Next";

    private final ObjectMapper mapper;
    private final HttpClient http;
    private static final String DEFAULT_API = "https://api.github.com";

    /**
     * API のベース URL。既定は {@code https://api.github.com}。
     * GitHub Enterprise や社内ミラーを使う施設向けに yml で差し替えられる（管理者設定）。
     *
     * <p><b>https のみ許可する</b>。ここから取得したものはアプリと同じ権限で動くコードになり得るため、
     * 平文 HTTP での取得は認めない（誤設定は起動時に落として気づかせる）。
     */
    private final String api;

    public HttpGitHubReleaseClient(ObjectMapper mapper,
                                   @Value("${graphy.plugins.github-api-base:" + DEFAULT_API + "}") String api) {
        this.mapper = mapper;
        this.api = requireHttps(api);
        this.http = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    @Override
    public List<Release> listReleases(String repo, String token) {
        String safe = requireRepo(repo);
        HttpRequest req = base(URI.create(api + "/repos/" + safe + "/releases?per_page=100"), token)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .GET().build();
        try {
            HttpResponse<byte[]> res = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (res.statusCode() / 100 != 2) {
                throw new PluginInstallException("GitHub releases fetch failed: HTTP " + res.statusCode()
                        + " for " + safe);
            }
            JsonNode arr = mapper.readTree(res.body());
            List<Release> out = new ArrayList<>();
            if (arr.isArray()) {
                for (JsonNode r : arr) out.add(toRelease(r));
            }
            return out;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new PluginInstallException("GitHub releases fetch error: " + e.getMessage());
        }
    }

    @Override
    public byte[] download(String url, String token) {
        HttpRequest req = base(URI.create(url), token)
                .header("Accept", "application/octet-stream")
                .GET().build();
        try {
            HttpResponse<byte[]> res = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (res.statusCode() / 100 != 2) {
                throw new PluginInstallException("asset download failed: HTTP " + res.statusCode());
            }
            return res.body();
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new PluginInstallException("asset download error: " + e.getMessage());
        }
    }

    private HttpRequest.Builder base(URI uri, String token) {
        HttpRequest.Builder b = HttpRequest.newBuilder(uri)
                .header("User-Agent", UA)
                .timeout(Duration.ofSeconds(60));
        if (token != null && !token.isBlank()) {
            b.header("Authorization", "Bearer " + token.trim());
        }
        return b;
    }

    private Release toRelease(JsonNode r) {
        List<Asset> assets = new ArrayList<>();
        JsonNode arr = r.get("assets");
        if (arr != null && arr.isArray()) {
            for (JsonNode a : arr) {
                assets.add(new Asset(
                        text(a, "name"),
                        text(a, "url"),
                        text(a, "browser_download_url"),
                        a.hasNonNull("size") ? a.get("size").asLong() : 0L));
            }
        }
        return new Release(
                text(r, "tag_name"),
                text(r, "name"),
                text(r, "body"),
                text(r, "published_at"),
                r.hasNonNull("prerelease") && r.get("prerelease").asBoolean(),
                assets);
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    /**
     * ベース URL を検証して末尾スラッシュを落とす。未設定・空は既定値。
     *
     * <p>https 以外（とくに平文 http）は<b>起動時に落とす</b>。ここから取得した配布物は
     * アプリと同じ権限で動くコードを含み得るため、経路の保護を欠いたまま黙って動かさない。
     *
     * @throws IllegalStateException https 以外が設定されている場合（管理者の誤設定）
     */
    static String requireHttps(String configured) {
        String url = configured == null || configured.isBlank() ? DEFAULT_API : configured.trim();
        url = url.replaceAll("/+$", "");
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("graphy.plugins.github-api-base is not a valid URL: " + configured);
        }
        if (uri.getScheme() == null || !uri.getScheme().equalsIgnoreCase("https") || uri.getHost() == null) {
            throw new IllegalStateException(
                    "graphy.plugins.github-api-base must be an https URL (got: " + configured + ")");
        }
        return url;
    }

    /** {@code owner/repo} 以外を弾く（SSRF/パス注入対策）。 */
    private static String requireRepo(String repo) {
        if (repo == null || !repo.matches("[A-Za-z0-9._-]+/[A-Za-z0-9._-]+")) {
            throw new PluginInstallException("invalid repo (expected owner/repo): " + repo);
        }
        return repo;
    }
}
