/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.cache;

import com.vis.graphynext.plugin.PluginRegistry;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Optional;

/**
 * プラグインの「消えてもよい」派生データの置き場（H68）。
 * <ul>
 *   <li>{@code PUT|GET|HEAD|DELETE /api/plugins/{id}/cache/item} — 1 件（本体は octet-stream）</li>
 *   <li>{@code PUT|GET|DELETE /api/plugins/{id}/cache/checkpoint/{index}}、{@code DELETE .../cache/checkpoint} — 途中結果</li>
 * </ul>
 * 鍵は<b>ヘッダ</b> {@value #KEY_HEADER}（UTF-8 をパーセントエンコード）で運ぶ。URL・クエリには載せない。
 * 失敗は {@code {"error": 理由コード}}: {@code invalid-key}(400)・{@code invalid-index}(400)・{@code too-large}(413)・
 * {@code not-found}(404)・{@code desktop-only}(501)・{@code write-failed}(500)。standalone 専用。
 */
@RestController
public class PluginCacheController {

    public static final String KEY_HEADER = "X-Plugin-Cache-Key";

    private final PluginRegistry registry;
    private final PluginCacheService service;

    public PluginCacheController(PluginRegistry registry, PluginCacheService service) {
        this.registry = registry;
        this.service = service;
    }

    // ── 1 件 ──────────────────────────────────────────────────────────────

    @PutMapping("/api/plugins/{id}/cache/item")
    public ResponseEntity<Object> put(@PathVariable String id, @RequestHeader(value = KEY_HEADER, required = false) String rawKey,
                                      HttpServletRequest request) throws IOException {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        String key = decode(rawKey);
        if (!PluginCacheService.validKey(key)) return error(HttpStatus.BAD_REQUEST, "invalid-key");
        byte[] body = readBody(request);
        if (body == null) return error(HttpStatus.PAYLOAD_TOO_LARGE, "too-large");
        return outcome(service.put(id, key, body));
    }

    @GetMapping("/api/plugins/{id}/cache/item")
    public ResponseEntity<Object> get(@PathVariable String id, @RequestHeader(value = KEY_HEADER, required = false) String rawKey) {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        String key = decode(rawKey);
        if (!PluginCacheService.validKey(key)) return error(HttpStatus.BAD_REQUEST, "invalid-key");
        return bytes(service.get(id, key));
    }

    @RequestMapping(value = "/api/plugins/{id}/cache/item", method = RequestMethod.HEAD)
    public ResponseEntity<Object> head(@PathVariable String id, @RequestHeader(value = KEY_HEADER, required = false) String rawKey) {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        String key = decode(rawKey);
        if (!PluginCacheService.validKey(key)) return ResponseEntity.badRequest().build();
        return service.has(id, key) ? ResponseEntity.ok().build() : ResponseEntity.notFound().build();
    }

    @DeleteMapping("/api/plugins/{id}/cache/item")
    public ResponseEntity<Object> remove(@PathVariable String id, @RequestHeader(value = KEY_HEADER, required = false) String rawKey) {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        String key = decode(rawKey);
        if (!PluginCacheService.validKey(key)) return error(HttpStatus.BAD_REQUEST, "invalid-key");
        service.remove(id, key);
        return ResponseEntity.ok(Map.of("ok", true));
    }

    // ── チェックポイント ─────────────────────────────────────────────────

    @PutMapping("/api/plugins/{id}/cache/checkpoint/{index}")
    public ResponseEntity<Object> putCheckpoint(@PathVariable String id, @PathVariable int index,
                                                @RequestHeader(value = KEY_HEADER, required = false) String rawKey,
                                                HttpServletRequest request) throws IOException {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        String key = decode(rawKey);
        if (!PluginCacheService.validKey(key)) return error(HttpStatus.BAD_REQUEST, "invalid-key");
        if (index < 0 || index > PluginCacheService.MAX_INDEX) return error(HttpStatus.BAD_REQUEST, "invalid-index");
        byte[] body = readBody(request);
        if (body == null) return error(HttpStatus.PAYLOAD_TOO_LARGE, "too-large");
        return outcome(service.saveCheckpoint(id, key, index, body));
    }

    @GetMapping("/api/plugins/{id}/cache/checkpoint/{index}")
    public ResponseEntity<Object> getCheckpoint(@PathVariable String id, @PathVariable int index,
                                                @RequestHeader(value = KEY_HEADER, required = false) String rawKey) {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        String key = decode(rawKey);
        if (!PluginCacheService.validKey(key)) return error(HttpStatus.BAD_REQUEST, "invalid-key");
        return bytes(service.loadCheckpoint(id, key, index));
    }

    @DeleteMapping("/api/plugins/{id}/cache/checkpoint")
    public ResponseEntity<Object> clearCheckpoints(@PathVariable String id,
                                                   @RequestHeader(value = KEY_HEADER, required = false) String rawKey) {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        String key = decode(rawKey);
        if (!PluginCacheService.validKey(key)) return error(HttpStatus.BAD_REQUEST, "invalid-key");
        service.clearCheckpoints(id, key);
        return ResponseEntity.ok(Map.of("ok", true));
    }

    // ── 共通 ──────────────────────────────────────────────────────────────

    /** 1 件の上限を超える本体は、読み込む前に Content-Length で、無ければ上限+1 バイトで打ち切って弾く（null）。 */
    private byte[] readBody(HttpServletRequest request) throws IOException {
        long max = service.maxItemBytes();
        if (request.getContentLengthLong() > max) return null;
        try (InputStream in = request.getInputStream()) {
            byte[] data = in.readNBytes((int) Math.min(Integer.MAX_VALUE - 8, max + 1));
            return data.length > max ? null : data;
        }
    }

    private static String decode(String raw) {
        if (raw == null) return null;
        try {
            return URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static ResponseEntity<Object> bytes(Optional<byte[]> data) {
        if (data.isEmpty()) return error(HttpStatus.NOT_FOUND, "not-found");
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM).body(data.get());
    }

    private static ResponseEntity<Object> outcome(PluginCacheService.Outcome o) {
        return switch (o) {
            case OK -> ResponseEntity.ok(Map.of("ok", true));
            case INVALID_KEY -> error(HttpStatus.BAD_REQUEST, "invalid-key");
            case INVALID_INDEX -> error(HttpStatus.BAD_REQUEST, "invalid-index");
            case TOO_LARGE -> error(HttpStatus.PAYLOAD_TOO_LARGE, "too-large");
            case WRITE_FAILED -> error(HttpStatus.INTERNAL_SERVER_ERROR, "write-failed");
        };
    }

    private static ResponseEntity<Object> error(HttpStatus status, String code) {
        return ResponseEntity.status(status).body(Map.of("error", code));
    }

    private Optional<ResponseEntity<Object>> guard(String id) {
        if (registry.manifests().stream().noneMatch(m -> id.equals(m.id()))) {
            return Optional.of(ResponseEntity.notFound().build());
        }
        if (!registry.localFilesAllowed()) {
            return Optional.of(error(HttpStatus.NOT_IMPLEMENTED, "desktop-only"));
        }
        return Optional.empty();
    }
}
