/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 偽の Jupyter Server（REST だけ）を相手にした単体テスト。WebSocket は結合テスト側で見る。 */
class JupyterServerClientTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private HttpServer server;
    private final List<String> log = Collections.synchronizedList(new ArrayList<>());
    private final List<JsonNode> bodies = Collections.synchronizedList(new ArrayList<>());
    private volatile Function<HttpExchange, Reply> handler;

    record Reply(int status, String body, String location) {
        static Reply json(int status, String body) {
            return new Reply(status, body, null);
        }
    }

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            log.add(ex.getRequestMethod() + " " + ex.getRequestURI() + " auth="
                    + ex.getRequestHeaders().getFirst("Authorization"));
            if (!body.isEmpty()) {
                bodies.add(mapper.readTree(body));
            }
            Reply r = handler.apply(ex);
            if (r.location() != null) {
                ex.getResponseHeaders().add("Location", r.location());
            }
            byte[] b = r.body() == null ? new byte[0] : r.body().getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(r.status(), b.length == 0 ? -1 : b.length);
            if (b.length > 0) {
                ex.getResponseBody().write(b);
            }
            ex.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private JupyterServerClient client(String token) {
        return new JupyterServerClient(
                JupyterEndpoint.of("http://127.0.0.1:" + server.getAddress().getPort() + "/base", token), mapper);
    }

    @Test
    void sendsTokenInHeader_andNeverInUrl() {
        handler = ex -> Reply.json(200, "{\"started\":\"x\"}");
        client("tok").status();
        assertEquals("GET /base/api/status auth=token tok", log.get(0));
    }

    @Test
    void rejectedTokenIsReported() {
        handler = ex -> Reply.json(403, "{}");
        JupyterException e = assertThrows(JupyterException.class, () -> client("bad").status());
        assertEquals(403, e.status());
        assertTrue(e.getMessage().contains("token rejected"));
    }

    @Test
    void redirectsAreNotFollowed() {
        // 追うと登録外の host へトークン付きで飛びうる
        handler = ex -> new Reply(302, null, "https://evil.example/api/status");
        JupyterException e = assertThrows(JupyterException.class, () -> client("tok").status());
        assertTrue(e.getMessage().contains("redirect not followed"));
        assertEquals(1, log.size());
    }

    @Test
    void startAndShutdownKernel() {
        handler = ex -> ex.getRequestMethod().equals("POST")
                ? Reply.json(201, "{\"id\":\"k-1\",\"name\":\"python3\"}")
                : Reply.json(204, null);
        JupyterServerClient c = client(null);
        assertEquals("k-1", c.startKernel("python3"));
        assertEquals("python3", bodies.get(0).path("name").asText());
        c.shutdownKernel("k-1");
        assertEquals("DELETE /base/api/kernels/k-1 auth=null", log.get(1));
    }

    @Test
    void uploadCreatesParentsThenFile() {
        handler = ex -> ex.getRequestMethod().equals("GET") ? Reply.json(404, "{}") : Reply.json(201, "{}");
        client(null).upload("job/inputs/a b.npz", new byte[]{1, 2, 3});
        assertEquals(List.of(
                "GET /base/api/contents/job?content=0 auth=null",
                "PUT /base/api/contents/job auth=null",
                "GET /base/api/contents/job/inputs?content=0 auth=null",
                "PUT /base/api/contents/job/inputs auth=null",
                "PUT /base/api/contents/job/inputs/a%20b.npz auth=null"), log);
        JsonNode file = bodies.get(2);
        assertEquals("base64", file.path("format").asText());
        assertEquals("AQID", file.path("content").asText());
        assertTrue(file.path("chunk").isMissingNode());
    }

    @Test
    void largeUploadIsChunked_lastChunkIsMinusOne() {
        handler = ex -> Reply.json(201, "{}");
        byte[] data = new byte[JupyterServerClient.UPLOAD_CHUNK_BYTES * 2 + 10];
        client(null).upload("big.bin", data);
        List<Integer> chunks = bodies.stream().map(b -> b.path("chunk").asInt()).toList();
        assertEquals(List.of(1, 2, -1), chunks);
    }

    @Test
    void downloadDecodesBase64_andMissingIsNull() {
        handler = ex -> ex.getRequestURI().getPath().endsWith("/out.txt")
                ? Reply.json(200, "{\"type\":\"file\",\"format\":\"base64\",\"content\":\"aGk=\"}")
                : Reply.json(404, "{}");
        JupyterServerClient c = client(null);
        assertArrayEquals("hi".getBytes(StandardCharsets.UTF_8), c.download("job/out.txt"));
        assertNull(c.download("job/none.txt"));
    }
}
