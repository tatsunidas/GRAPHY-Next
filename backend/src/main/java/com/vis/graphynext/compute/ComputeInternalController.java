/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * Electron main だけが叩く口（{@link MainChannelFilter} が守る）。設計: fw/remote-compute-design.md §4.1。
 *
 * <p>レンダラ向けの口ではない。設定画面は IPC で main に頼み、main がここを叩く。
 */
@RestController
@Profile("standalone")
@RequestMapping("/api/internal/compute")
public class ComputeInternalController {

    private static final Logger log = LoggerFactory.getLogger(ComputeInternalController.class);
    private static final Duration TEST_TIMEOUT = Duration.ofSeconds(90);

    private final ComputeEndpointRegistry registry;
    private final ComputeConnectionTester tester;

    public ComputeInternalController(ComputeEndpointRegistry registry, ComputeConnectionTester tester) {
        this.registry = registry;
        this.tester = tester;
    }

    public record EndpointsBody(List<ComputeEndpointRegistry.Incoming> endpoints) {
    }

    /** 接続先を丸ごと入れ替える（トークン込み。メモリにだけ持つ）。 */
    @PutMapping("/endpoints")
    public ResponseEntity<Map<String, Object>> replace(@RequestBody EndpointsBody body) {
        List<String> problems = registry.replaceAll(body == null ? null : body.endpoints());
        if (!problems.isEmpty()) {
            log.warn("[compute] endpoints rejected: {}", problems);
            return ResponseEntity.badRequest().body(Map.of("ok", false, "problems", problems));
        }
        // 🔴 トークンはログに出さない（id と host だけ）
        log.info("[compute] endpoints registered: {}", registry.all().stream()
                .map(e -> e.id() + "=" + e.endpoint().base().getHost()).toList());
        return ResponseEntity.ok(Map.of("ok", true, "count", registry.all().size()));
    }

    /** 接続テスト。実行するコードは {@link ComputeConnectionTester#PROBE} の定数だけ。 */
    @PostMapping("/endpoints/{id}/test")
    public ComputeConnectionTester.Result test(@PathVariable String id) {
        ComputeConnectionTester.Result r = tester.test(id, TEST_TIMEOUT);
        log.info("[compute] connection test {}: ok={} stage={} {}ms", id, r.ok(), r.stage(), r.elapsedMs());
        return r;
    }
}
