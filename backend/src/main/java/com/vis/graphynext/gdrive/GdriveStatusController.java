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
    private final GdriveRestoreService restore;

    public GdriveStatusController(GdriveSyncService sync, GdriveRestoreService restore) {
        this.sync = sync;
        this.restore = restore;
    }

    @GetMapping("/restore")
    public GdriveRestoreService.Progress restoreProgress() {
        return restore.progress();
    }

    /** 他端末が使用中でも使い始める。画面で確認を取ったあとに呼ぶ。 */
    @PostMapping("/takeover")
    public ResponseEntity<Map<String, Object>> takeOver() {
        sync.takeOver();
        return ResponseEntity.accepted().body(Map.of("ok", true));
    }

    @GetMapping("/status")
    public GdriveSyncService.Status status() {
        return sync.status();
    }

    /** すべてローカルに保存する（モード A）。空き容量が足りなければ 400 not-enough-space で、何も取らない。 */
    @PostMapping("/localize")
    public ResponseEntity<Map<String, Object>> localize() {
        String err = sync.startLocalize();
        return err == null ? ResponseEntity.accepted().body(Map.of("ok", true))
                : ResponseEntity.badRequest().body(Map.of("ok", false, "error", err));
    }

    @GetMapping("/localize")
    public GdriveSyncService.LocalizeProgress localizeProgress() {
        return sync.localizeProgress();
    }

    @org.springframework.web.bind.annotation.DeleteMapping("/localize")
    public Map<String, Object> cancelLocalize() {
        sync.cancelLocalize();
        return Map.of("ok", true);
    }

    @PostMapping("/sync")
    public ResponseEntity<Map<String, Object>> syncNow() {
        sync.syncNow();
        return ResponseEntity.accepted().body(Map.of("ok", true));
    }
}
