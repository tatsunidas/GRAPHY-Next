/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import org.junit.jupiter.api.Test;

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
}
