/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.plugin.PluginProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.env.StandardEnvironment;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 公式索引の解析（{@link PluginCatalog}）と、{@link PluginManagerService#catalog()} の取得・キャッシュ・重ね合わせ。 */
class PluginCatalogTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String URL = "https://example.test/index.json";

    private static byte[] b(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private static final String GOOD = """
            {"plugins":[
              {"id":"art","name":"Art of Imaging","repo":"tatsunidas/graphy-next-plugin-art",
               "description":"AI 画像生成","category":"ai","signerKeyId":"98ea7c6ba2d50118","minGraphy":"0.4.0"},
              {"id":"monai","name":"MONAI","repo":"tatsunidas/graphy-next-plugin-monai"}
            ]}""";

    // ---- 解析 ----

    @Test
    void parsesGoodIndexAndNormalizesKeyId() {
        PluginCatalog.Parsed p = PluginCatalog.parse(b(GOOD), MAPPER);
        assertEquals(2, p.entries().size());
        assertTrue(p.rejected().isEmpty());
        assertEquals("98EA7C6BA2D50118", p.entries().get(0).signerKeyId());
        assertNull(p.entries().get(1).signerKeyId());
    }

    @Test
    void badRowsAreDroppedButGoodRowsSurvive() {
        String json = """
                {"plugins":[
                  {"id":"ok","name":"OK","repo":"a/b"},
                  {"id":"Bad Id","name":"x","repo":"a/b"},
                  {"id":"norepo","name":"x","repo":"not a repo"},
                  {"id":"nokey","name":"x","repo":"a/b","signerKeyId":"zz"},
                  {"id":"noname","repo":"a/b"},
                  {"id":"ok","name":"dup","repo":"a/b"},
                  "string"
                ]}""";
        PluginCatalog.Parsed p = PluginCatalog.parse(b(json), MAPPER);
        assertEquals(List.of("ok"), p.entries().stream().map(PluginCatalog.Entry::id).toList());
        assertEquals(6, p.rejected().size());
    }

    @Test
    void wholeFileProblemsAreRejected() {
        assertThrows(PluginInstallException.class, () -> PluginCatalog.parse(b("not json"), MAPPER));
        assertThrows(PluginInstallException.class, () -> PluginCatalog.parse(b("[]"), MAPPER));
        assertThrows(PluginInstallException.class, () -> PluginCatalog.parse(b("{\"plugins\":{}}"), MAPPER));
    }

    @Test
    void overlongDescriptionIsClipped() {
        String long600 = "x".repeat(600);
        PluginCatalog.Parsed p = PluginCatalog.parse(
                b("{\"plugins\":[{\"id\":\"a\",\"name\":\"A\",\"repo\":\"a/b\",\"description\":\"" + long600 + "\"}]}"),
                MAPPER);
        assertEquals(500, p.entries().get(0).description().length());
    }

    // ---- サービス ----

    private PluginManagerService service(Path dir, String indexUrl, AtomicReference<byte[]> body,
                                         AtomicReference<String> seenToken) {
        PluginProperties props = new PluginProperties();
        props.setDir(dir.toString());
        props.setIndexUrl(indexUrl);
        props.setGithubToken("secret-token");
        GitHubReleaseClient client = new GitHubReleaseClient() {
            @Override
            public List<Release> listReleases(String repo, String token) {
                return List.of();
            }

            @Override
            public byte[] download(String url, String token) {
                seenToken.set(token);
                byte[] cur = body.get();
                if (cur == null) throw new PluginInstallException("asset download failed: HTTP 503");
                return cur;
            }
        };
        StandardEnvironment env = new StandardEnvironment();
        env.setActiveProfiles("standalone");
        return new PluginManagerService(props, MAPPER, client, env, () -> true,
                new org.springframework.beans.factory.support.StaticListableBeanFactory()
                        .getBeanProvider(com.vis.graphynext.plugin.PluginRegistry.class),
                "0.4.0");
    }

    @Test
    void unconfiguredIndexReturnsEmptyAndNotConfigured(@TempDir Path dir) {
        var view = service(dir, null, new AtomicReference<>(b(GOOD)), new AtomicReference<>()).catalog();
        assertFalse(view.configured());
        assertTrue(view.plugins().isEmpty());
    }

    @Test
    void fetchesParsesAndNeverSendsTheGithubToken(@TempDir Path dir) {
        AtomicReference<String> seen = new AtomicReference<>("untouched");
        var view = service(dir, URL, new AtomicReference<>(b(GOOD)), seen).catalog();
        assertTrue(view.configured());
        assertFalse(view.stale());
        assertEquals(2, view.plugins().size());
        assertNull(view.plugins().get(0).installed());
        assertNull(seen.get(), "索引の取得に GitHub トークンを付けてはいけない");
        assertTrue(Files.isRegularFile(dir.resolve("catalog-cache.json")));
    }

    @Test
    void fallsBackToCacheWhenFetchFails(@TempDir Path dir) {
        AtomicReference<byte[]> body = new AtomicReference<>(b(GOOD));
        PluginManagerService svc = service(dir, URL, body, new AtomicReference<>());
        svc.catalog();
        body.set(null);
        var view = svc.catalog();
        assertTrue(view.stale());
        assertNotNull(view.error());
        assertEquals(2, view.plugins().size());
    }

    @Test
    void brokenIndexKeepsLastGoodCacheAndDoesNotOverwriteIt(@TempDir Path dir) throws Exception {
        AtomicReference<byte[]> body = new AtomicReference<>(b(GOOD));
        PluginManagerService svc = service(dir, URL, body, new AtomicReference<>());
        svc.catalog();
        body.set(b("<html>captive portal</html>"));
        var view = svc.catalog();
        assertTrue(view.stale());
        assertEquals(2, view.plugins().size());
        assertEquals(GOOD, Files.readString(dir.resolve("catalog-cache.json")));
    }

    @Test
    void failureWithoutCacheIsEmptyWithReason(@TempDir Path dir) {
        var view = service(dir, URL, new AtomicReference<>(null), new AtomicReference<>()).catalog();
        assertTrue(view.stale());
        assertTrue(view.plugins().isEmpty());
        assertNotNull(view.error());
    }

    @Test
    void nonHttpsIndexUrlIsRefused(@TempDir Path dir) {
        var view = service(dir, "http://example.test/index.json", new AtomicReference<>(b(GOOD)),
                new AtomicReference<>()).catalog();
        assertNotNull(view.error());
        assertTrue(view.plugins().isEmpty());
    }

    @Test
    void installedStateIsOverlaidOnTheEntry(@TempDir Path dir) throws Exception {
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("installed.json"), """
                [{"id":"monai","name":"MONAI","version":"0.1.0",
                  "source":{"type":"bundled","ref":"tatsunidas/graphy-next-plugin-monai"},
                  "enabled":true,"pinned":false,"trust":"verified"}]""");
        var view = service(dir, URL, new AtomicReference<>(b(GOOD)), new AtomicReference<>()).catalog();
        var art = view.plugins().stream().filter(p -> p.id().equals("art")).findFirst().orElseThrow();
        var monai = view.plugins().stream().filter(p -> p.id().equals("monai")).findFirst().orElseThrow();
        assertNull(art.installed());
        assertEquals("0.1.0", monai.installed().version());
        assertEquals("bundled", monai.installed().sourceType());
        assertEquals("verified", monai.installed().trust());
    }

    @Test
    void requiresTheUserOptIn(@TempDir Path dir) {
        PluginProperties props = new PluginProperties();
        props.setDir(dir.toString());
        props.setIndexUrl(URL);
        StandardEnvironment env = new StandardEnvironment();
        env.setActiveProfiles("standalone");
        PluginManagerService svc = new PluginManagerService(props, MAPPER, new GitHubReleaseClient() {
            public List<Release> listReleases(String repo, String token) { return List.of(); }
            public byte[] download(String url, String token) { return b(GOOD); }
        }, env, () -> false,
                new org.springframework.beans.factory.support.StaticListableBeanFactory()
                        .getBeanProvider(com.vis.graphynext.plugin.PluginRegistry.class),
                "0.4.0");
        assertThrows(PluginManagerForbiddenException.class, svc::catalog);
    }
}
