/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.video;

import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginManifest;
import com.vis.graphynext.plugin.PluginRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.Map;
import java.util.Optional;

/**
 * プラグインのための動画の取り込み REST（host API の H47 / H48 / H49）。
 *
 * <ul>
 *   <li>{@code POST /api/plugins/{id}/video/probe} — 諸元・指紋・既に取り込み済みか（H47）</li>
 *   <li>{@code POST /api/plugins/{id}/video/imports} — 取り込みをジョブとして投入（H48。状態は
 *       {@code /api/plugin-jobs/{jobId}}）</li>
 *   <li>{@code GET  /api/plugins/{id}/video/frame-values/{sop}} — フレームごとの値の SR を読む（H49）</li>
 * </ul>
 * 🔴 <b>出所（プラグイン名・版）は本体がマニフェストから入れる</b>。要求本文に名乗らせない。
 * 確認ダイアログは画面側の host が必ず出す（H4b / H9 と同じ。{@code pluginVideoApi.ts}）。
 */
@RestController
public class PluginVideoController {

    private static final Logger log = LoggerFactory.getLogger(PluginVideoController.class);

    private final PluginRegistry registry;
    private final PluginJobService jobs;
    private final PluginVideoImportService service;

    public PluginVideoController(PluginRegistry registry, PluginJobService jobs, PluginVideoImportService service) {
        this.registry = registry;
        this.jobs = jobs;
        this.service = service;
    }

    @PostMapping("/api/plugins/{id}/video/probe")
    public ResponseEntity<Object> probe(@PathVariable String id, @RequestBody Map<String, Object> body) {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        Object path = body == null ? null : body.get("path");
        if (!(path instanceof String p) || p.isBlank()) return bad("path は必須です");
        try {
            return ResponseEntity.ok(service.probe(p));
        } catch (IOException e) {
            return bad(e.getMessage());
        }
    }

    @PostMapping("/api/plugins/{id}/video/imports")
    public ResponseEntity<Object> importVideo(@PathVariable String id,
                                              @RequestBody PluginVideoImportService.ImportRequest req) {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        PluginManifest m = manifest(id).orElseThrow();
        FrameValuesSr.Producer producer = new FrameValuesSr.Producer(m.id(), m.name(), m.version());
        return ResponseEntity.ok(jobs.submitTask(id, ctx -> service.importVideo(req, producer, ctx)));
    }

    @GetMapping("/api/plugins/{id}/video/frame-values/{sop}")
    public ResponseEntity<Object> frameValues(@PathVariable String id, @PathVariable String sop) {
        if (manifest(id).isEmpty()) return ResponseEntity.notFound().build();
        try {
            FrameValuesSr.Read r = service.readFrameValues(id, sop);
            return r == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(r);
        } catch (IOException e) {
            log.warn("[plugin-video] frame values unreadable for {}: {}", sop, e.toString());
            return ResponseEntity.status(500).body(Map.of("error", String.valueOf(e.getMessage())));
        }
    }

    /** プラグインが無い=404 / web モード=501。 */
    private Optional<ResponseEntity<Object>> guard(String id) {
        if (manifest(id).isEmpty()) return Optional.of(ResponseEntity.notFound().build());
        if (!registry.localFilesAllowed()) {
            return Optional.of(ResponseEntity.status(501).body(Map.of("error", "desktop-only")));
        }
        return Optional.empty();
    }

    private Optional<PluginManifest> manifest(String id) {
        return registry.manifests().stream().filter(m -> id.equals(m.id())).findFirst();
    }

    private static ResponseEntity<Object> bad(String msg) {
        return ResponseEntity.badRequest().body(Map.of("error", String.valueOf(msg)));
    }
}
