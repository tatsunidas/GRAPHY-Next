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

    public GdriveInternalController(GdriveSyncService sync) {
        this.sync = sync;
    }

    public record ConfigBody(String clientId, String clientSecret, String refreshToken, String folderId,
                             String driveId, String name) {
        @Override
        public String toString() {
            return "ConfigBody[folderId=" + folderId + "]"; // 🔴 秘密を出さない
        }
    }

    @PutMapping("/config")
    public ResponseEntity<Map<String, Object>> put(@RequestBody ConfigBody b) {
        GdriveConfig cfg = new GdriveConfig(b.clientId(), b.clientSecret(), b.refreshToken(), b.folderId(),
                b.driveId(), b.name());
        String problem = cfg.problem();
        if (problem != null) {
            log.warn("[gdrive] config rejected: {}", problem);
            return ResponseEntity.badRequest().body(Map.of("ok", false, "error", problem));
        }
        sync.configure(cfg);
        return ResponseEntity.ok(Map.of("ok", true));
    }

    @DeleteMapping("/config")
    public Map<String, Object> delete() {
        sync.configure(null);
        return Map.of("ok", true);
    }
}
