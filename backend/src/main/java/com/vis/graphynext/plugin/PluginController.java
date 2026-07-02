/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;

/**
 * プラグイン REST（両モード共通の契約）。設計: fw/plugin-architecture.md。
 *
 * <ul>
 *   <li>{@code GET  /api/plugins} — マニフェスト一覧</li>
 *   <li>{@code GET  /api/plugins/{id}/ui.js} — UI バンドル（ES モジュール）配信</li>
 *   <li>{@code POST /api/plugins/{id}/run} — バックエンド面の実行</li>
 * </ul>
 * 実体は起動プロファイルで {@link StandalonePluginRegistry} / {@link WebPluginRegistry} が注入される。
 */
@RestController
@RequestMapping("/api/plugins")
public class PluginController {

    private static final Logger log = LoggerFactory.getLogger(PluginController.class);
    private static final MediaType JS = MediaType.parseMediaType("text/javascript");

    private final PluginRegistry registry;

    public PluginController(PluginRegistry registry) {
        this.registry = registry;
    }

    /** マニフェスト一覧。 */
    @GetMapping
    public List<PluginManifest> list() {
        return registry.manifests();
    }

    /** UI バンドル（ES モジュール）を配信。 */
    @GetMapping("/{id}/ui.js")
    public ResponseEntity<byte[]> ui(@PathVariable String id) {
        Optional<byte[]> bundle = registry.uiBundle(id);
        if (bundle.isEmpty()) return ResponseEntity.notFound().build();
        return ResponseEntity.ok().contentType(JS).body(bundle.get());
    }

    /** バックエンド面を実行。存在しない=404 / モード非対応=501 / それ以外=500。 */
    @PostMapping("/{id}/run")
    public ResponseEntity<Object> run(@PathVariable String id,
                                      @RequestBody(required = false) Map<String, Object> payload) {
        try {
            Object result = registry.run(id, payload);
            return ResponseEntity.ok(result == null ? Map.of() : result);
        } catch (NoSuchElementException e) {
            return ResponseEntity.notFound().build();
        } catch (UnsupportedOperationException e) {
            log.info("[plugins] run not available for {}: {}", id, e.getMessage());
            return ResponseEntity.status(501).body(Map.of("error", String.valueOf(e.getMessage())));
        } catch (Exception e) {
            log.warn("[plugins] run failed {}: {}", id, e.getMessage());
            return ResponseEntity.status(500).body(Map.of("error", String.valueOf(e.getMessage())));
        }
    }
}
