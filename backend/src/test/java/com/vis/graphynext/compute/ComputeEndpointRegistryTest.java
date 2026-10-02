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
}
