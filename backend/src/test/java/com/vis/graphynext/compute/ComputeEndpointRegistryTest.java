/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ComputeEndpointRegistryTest {

    private static ComputeEndpointRegistry.Incoming in(String id, String url) {
        return new ComputeEndpointRegistry.Incoming(id, "GPU " + id, url, "tok-" + id);
    }

    @Test
    void replacesAll() {
        ComputeEndpointRegistry r = new ComputeEndpointRegistry();
        assertTrue(r.replaceAll(List.of(in("lab", "https://gpu.example.org/j"), in("box", "http://gpuserver:8888")))
                .isEmpty());
        assertEquals(2, r.all().size());
        assertEquals("token tok-lab", r.get("lab").orElseThrow().endpoint().authorization());
        assertTrue(r.client("box", new ObjectMapper()).isPresent());
        assertTrue(r.replaceAll(List.of()).isEmpty());
        assertTrue(r.all().isEmpty());
    }

    @Test
    void oneBadEntryChangesNothing() {
        ComputeEndpointRegistry r = new ComputeEndpointRegistry();
        r.replaceAll(List.of(in("lab", "https://gpu.example.org")));
        List<String> problems = r.replaceAll(List.of(in("ok", "https://a.org"), in("bad", "http://8.8.8.8")));
        assertFalse(problems.isEmpty());
        assertEquals(List.of("lab"), r.all().stream().map(ComputeEndpointRegistry.Entry::id).toList(),
                "半端な状態を作らない");
    }

    @Test
    void rejectsBadIdsDuplicatesAndTooMany() {
        ComputeEndpointRegistry r = new ComputeEndpointRegistry();
        assertFalse(r.replaceAll(List.of(in("../x", "https://a.org"))).isEmpty());
        assertFalse(r.replaceAll(List.of(in("Lab", "https://a.org"))).isEmpty());
        assertFalse(r.replaceAll(List.of(in("a", "https://a.org"), in("a", "https://b.org"))).isEmpty());
        List<ComputeEndpointRegistry.Incoming> many = new java.util.ArrayList<>();
        for (int i = 0; i <= ComputeEndpointRegistry.MAX_ENDPOINTS; i++) {
            many.add(in("e" + i, "https://a.org"));
        }
        assertEquals(List.of("too-many-endpoints"), r.replaceAll(many));
    }

    @Test
    void entryNeverPrintsToken() {
        ComputeEndpointRegistry r = new ComputeEndpointRegistry();
        r.replaceAll(List.of(in("lab", "https://gpu.example.org")));
        assertFalse(r.all().toString().contains("tok-lab"));
    }

    @Test
    void colabEntriesUseColabAuth_andUnknownKindIsRejected() {
        ComputeEndpointRegistry r = new ComputeEndpointRegistry();
        assertTrue(r.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("colab", "Colab T4",
                "https://8080-m-s-x.prod.colab.dev", "rt", "colab"))).isEmpty());
        assertEquals(JupyterEndpoint.Auth.COLAB, r.get("colab").orElseThrow().endpoint().auth());
        assertFalse(r.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("x", "X", "https://a.org", "t", "ssh")))
                .isEmpty());
    }

    private static ComputeEndpointRegistry.Incoming local(String url) {
        return new ComputeEndpointRegistry.Incoming("local", "this-pc", url, "tok", "local", "/usr/bin/python3");
    }

    @Test
    void localAcceptsOnlyHttpOn127001() {
        ComputeEndpointRegistry r = new ComputeEndpointRegistry();
        assertTrue(r.replaceAll(List.of(local("http://127.0.0.1:18931/"))).isEmpty(), "正例");
        ComputeEndpointRegistry.Entry e = r.get("local").orElseThrow();
        assertEquals("local", e.kind());
        assertEquals("/usr/bin/python3", e.expectedExecutable());
        assertEquals(JupyterEndpoint.Auth.JUPYTER, e.endpoint().auth());
        // 負例: 名前解決が要る localhost・LAN の IP・公開側・別のスキーム・IPv6 は「この PC」にしない
        for (String bad : List.of("http://localhost:18931/", "http://192.168.1.5:18931/", "http://0.0.0.0:1/",
                "https://127.0.0.1:18931/", "http://[::1]:18931/", "http://gpuserver:8888/")) {
            assertFalse(new ComputeEndpointRegistry().replaceAll(List.of(local(bad))).isEmpty(), bad);
        }
    }

    @Test
    void otherKindsDoNotKeepAnExpectedExecutable() {
        ComputeEndpointRegistry r = new ComputeEndpointRegistry();
        r.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("lab", "Lab", "https://a.org", "t", "jupyter", "/x")));
        assertEquals("jupyter", r.get("lab").orElseThrow().kind());
        assertEquals(null, r.get("lab").orElseThrow().expectedExecutable());
    }
}
