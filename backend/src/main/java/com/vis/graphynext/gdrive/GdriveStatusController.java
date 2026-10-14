/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** 画面向け。秘密は含まない（状態と件数だけ）。 */
@RestController
@Profile("standalone")
@RequestMapping("/api/gdrive")
public class GdriveStatusController {

    private final GdriveSyncService sync;

    public GdriveStatusController(GdriveSyncService sync) {
        this.sync = sync;
    }

    @GetMapping("/status")
    public GdriveSyncService.Status status() {
        return sync.status();
    }

    @PostMapping("/sync")
    public ResponseEntity<Map<String, Object>> syncNow() {
        sync.syncNow();
        return ResponseEntity.accepted().body(Map.of("ok", true));
    }
}
