/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** Electron main だけが叩く口（{@code MainChannelFilter} が守る）。秘密はここからメモリにだけ入る。 */
@RestController
@Profile("standalone")
@RequestMapping("/api/internal/gdrive")
public class GdriveInternalController {

    private static final Logger log = LoggerFactory.getLogger(GdriveInternalController.class);

    private final GdriveSyncService sync;
    private final GdriveRestoreService restore;

    public GdriveInternalController(GdriveSyncService sync, GdriveRestoreService restore) {
        this.sync = sync;
        this.restore = restore;
    }

    public record ConfigBody(Boolean enabled, String clientId, String clientSecret, String refreshToken,
                             String folderId, String driveId, String name, String email, String deviceId,
                             String host) {
        @Override
        public String toString() {
            return "ConfigBody[folderId=" + folderId + "]"; // 🔴 秘密を出さない
        }
    }

    @PutMapping("/config")
    public ResponseEntity<Map<String, Object>> put(@RequestBody ConfigBody b) {
        if (Boolean.FALSE.equals(b.enabled())) {
            sync.configure(null);
            return ResponseEntity.ok(Map.of("ok", true, "enabled", false));
        }
        GdriveConfig cfg = new GdriveConfig(b.clientId(), b.clientSecret(), b.refreshToken(), b.folderId(),
                b.driveId(), b.name(), b.deviceId(), b.host());
        String problem = cfg.problem();
        if (problem != null) {
            log.warn("[gdrive] config rejected: {}", problem);
            return ResponseEntity.badRequest().body(Map.of("ok", false, "error", problem));
        }
        sync.configure(cfg);
        return ResponseEntity.ok(Map.of("ok", true));
    }

    public record RestoreBody(String clientId, String clientSecret, String refreshToken, String sourceFolderId,
                              String destDir) {
        @Override
        public String toString() {
            return "RestoreBody[sourceFolderId=" + sourceFolderId + "]"; // 🔴 秘密を出さない
        }
    }

    /** Drive のバックアップを、別の空の DB フォルダへ取り戻す（開始だけ。進み具合は /api/gdrive/restore）。 */
    @PostMapping("/restore")
    public ResponseEntity<Map<String, Object>> restore(@RequestBody RestoreBody b) {
        GdriveConfig src = new GdriveConfig(b.clientId(), b.clientSecret(), b.refreshToken(), b.sourceFolderId(),
                null, "restore", "restore-device", "");
        String err = b.destDir() == null ? "dest-not-absolute" : restore.start(src, java.nio.file.Path.of(b.destDir()));
        return err == null ? ResponseEntity.accepted().body(Map.of("ok", true))
                : ResponseEntity.badRequest().body(Map.of("ok", false, "error", err));
    }

    @DeleteMapping("/config")
    public Map<String, Object> delete() {
        sync.configure(null);
        return Map.of("ok", true);
    }
}
