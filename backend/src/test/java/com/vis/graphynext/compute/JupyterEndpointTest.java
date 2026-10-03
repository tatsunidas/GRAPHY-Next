/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JupyterEndpointTest {

    @Test
    void httpsIsAccepted_andBaseGetsTrailingSlash() {
        JupyterEndpoint ep = JupyterEndpoint.of("https://gpu.example.org/user/a", "tok");
        assertEquals("https://gpu.example.org/user/a/", ep.base().toString());
        assertEquals("https://gpu.example.org/user/a/api/status", ep.http("api/status").toString());
        assertEquals("token tok", ep.authorization());
    }

    @Test
    void plainHttp_onlyForLoopbackAndPrivateAddresses() {
        // desktop/aiProviders.js の allowsPlainHttp と同じ表（ずれると画面と backend で判定が食い違う）
        for (String ok : new String[]{"http://localhost:8888", "http://127.0.0.1:8888", "http://10.1.2.3",
                "http://172.16.0.5", "http://192.168.1.20:8888", "http://[::1]:8888", "http://gpuserver:8888",
                "http://my-gpu.local", "http://gpu.lab.internal", "http://a.lan", "http://box.home.arpa"}) {
            JupyterEndpoint.of(ok, null);
        }
        for (String ng : new String[]{"http://gpu.example.org", "http://8.8.8.8", "http://172.32.0.1",
                "http://[fd12::1]", "http://192.169.0.1"}) {
            assertThrows(IllegalArgumentException.class, () -> JupyterEndpoint.of(ng, null), ng);
        }
    }

    @Test
    void rejectsOtherSchemesQueriesAndCredentials() {
        assertThrows(IllegalArgumentException.class, () -> JupyterEndpoint.of("ftp://x.org", null));
        assertThrows(IllegalArgumentException.class, () -> JupyterEndpoint.of("https://x.org/?token=a", null));
        assertThrows(IllegalArgumentException.class, () -> JupyterEndpoint.of("https://x.org/#a", null));
        assertThrows(IllegalArgumentException.class, () -> JupyterEndpoint.of("https://u:p@x.org/", null));
    }

    @Test
    void tokenIsNeverPrinted() {
        JupyterEndpoint ep = JupyterEndpoint.of("https://x.org", "secret-token");
        assertFalse(ep.toString().contains("secret-token"));
        assertNull(JupyterEndpoint.of("https://x.org", "  ").authorization());
    }

    @Test
    void kernelChannelsUsesWebSocketScheme() {
        assertEquals("wss://x.org/j/api/kernels/k1/channels?session_id=s%201",
                JupyterEndpoint.of("https://x.org/j/", null).kernelChannels("k1", "s 1").toString());
        assertTrue(JupyterEndpoint.of("http://127.0.0.1:8888", null).kernelChannels("k", "s")
                .toString().startsWith("ws://127.0.0.1:8888/api/kernels/k/"));
    }

    @Test
    void segmentRejectsTraversal() {
        for (String bad : new String[]{"..", ".", "a/b", "a\\b", ""}) {
            assertThrows(IllegalArgumentException.class, () -> JupyterEndpoint.segment(bad), bad);
        }
        assertThrows(IllegalArgumentException.class, () -> JupyterServerClient.segments("a/../b"));
        assertEquals(java.util.List.of("a", "b"), JupyterServerClient.segments("/a//b/"));
    }

    @Test
    void colabUsesTheProxyTokenHeaderAndContentFolder() {
        JupyterEndpoint ep = JupyterEndpoint.of("https://8080-m-s-x.asia-southeast1-2.prod.colab.dev", "SECRET-RT",
                JupyterEndpoint.Auth.COLAB);
        assertEquals(java.util.Map.of("X-Colab-Client-Agent", "graphy-next", "X-Colab-Runtime-Proxy-Token", "SECRET-RT"),
                ep.headers());
        assertNull(ep.authorization(), "Colab へ Authorization は付けない");
        assertEquals("content/graphy", ep.workRoot(), "Colab の Contents の根は OS の根なので content/ の下");
        assertEquals("graphy", JupyterEndpoint.of("https://x.org", "t").workRoot());
        assertEquals(java.util.Map.of("Authorization", "token t"), JupyterEndpoint.of("https://x.org", "t").headers());
        assertFalse(ep.toString().contains("SECRET-RT"));
    }
}
