/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Map;

/**
 * 自動削除の条件・試算・ロック・開いている検査の登録（standalone のみ。web モードではこのクラスも Bean も無く 404）。
 * <b>このコントローラに削除の入口は無い</b>（試算は計画を返すだけ）。
 */
@RestController
@Profile("standalone")
@RequestMapping("/api/dbadmin/retention")
public class RetentionController {

    private final RetentionService service;
    private final InUseRegistry inUse;

    public RetentionController(RetentionService service, InUseRegistry inUse) {
        this.service = service;
        this.inUse = inUse;
    }

    @GetMapping("/config")
    public RetentionConfig config() {
        return bad(service::config);
    }

    @PutMapping("/config")
    public RetentionConfig saveConfig(@RequestBody RetentionConfig cfg) {
        return bad(() -> service.saveConfig(cfg));
    }

    @PostMapping("/preview")
    public RetentionPlan preview() {
        return bad(service::preview);
    }

    @GetMapping("/status")
    public RetentionService.Status status() {
        return service.status();
    }

    @GetMapping("/holds")
    public List<RetentionService.Hold> holds() {
        return service.listHolds();
    }

    @PutMapping("/holds/{studyUid}")
    public RetentionService.Hold lock(@PathVariable String studyUid) {
        return bad(() -> service.lock(studyUid));
    }

    @DeleteMapping("/holds/{studyUid}")
    public void unlock(@PathVariable String studyUid) {
        service.unlock(studyUid);
    }

    /** ビューアが検査を開いたとき（sendBeacon でも呼べるよう POST）。 */
    @PostMapping("/in-use/register")
    public void register(@RequestBody Map<String, List<String>> body) {
        inUse.register(body.getOrDefault("studyUids", List.of()));
    }

    /** ビューアが検査を閉じたとき。 */
    @PostMapping("/in-use/release")
    public void release(@RequestBody Map<String, List<String>> body) {
        inUse.release(body.getOrDefault("studyUids", List.of()));
    }

    private static <T> T bad(java.util.function.Supplier<T> s) {
        try {
            return s.get();
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }
}
