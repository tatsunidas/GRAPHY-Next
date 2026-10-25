/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import org.springframework.context.annotation.Profile;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
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
    private final RetentionRunner runner;
    private final RetentionEventRepository events;
    private final RetentionRunRepository runs;

    public RetentionController(RetentionService service, InUseRegistry inUse, RetentionRunner runner,
                               RetentionEventRepository events, RetentionRunRepository runs) {
        this.service = service;
        this.inUse = inUse;
        this.runner = runner;
        this.events = events;
        this.runs = runs;
    }

    @GetMapping("/config")
    public RetentionConfig config() {
        return bad(service::config);
    }

    @PutMapping("/config")
    public RetentionConfig saveConfig(@RequestBody RetentionConfig cfg) {
        return bad(() -> service.saveConfig(cfg));
    }

    /** 試算。計画と、有効化に添える previewId を返す（何も消さない）。 */
    @PostMapping("/preview")
    public RetentionService.Preview preview() {
        return bad(service::previewWithId);
    }

    /** 有効にする。今の条件で試算した previewId が要る。最初の 1 回は、その試算で見た検査だけを消す。 */
    @PostMapping("/enable")
    public RetentionService.Status enable(@RequestBody Map<String, String> body) {
        try {
            service.enable(body.get("previewId"));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage(), e);
        }
        return service.status();
    }

    @PostMapping("/disable")
    public RetentionService.Status disable() {
        service.disable();
        return service.status();
    }

    /** 今すぐ実行（有効なときだけ）。走行中・無効なら 409。 */
    @PostMapping("/run")
    public RetentionRun run() {
        try {
            return runner.runNow();
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage(), e);
        }
    }

    /** 削除の記録（新しい順）。 */
    @GetMapping("/events")
    public List<RetentionEvent> events(@RequestParam(defaultValue = "100") int limit) {
        return events.findAllByOrderByAtDesc(PageRequest.of(0, Math.max(1, Math.min(limit, 1000))));
    }

    @GetMapping("/runs")
    public List<RetentionRun> runs(@RequestParam(defaultValue = "50") int limit) {
        return runs.findAllByOrderByAtDesc(PageRequest.of(0, Math.max(1, Math.min(limit, 1000))));
    }

    /** まだ見ていない、知らせる価値のある実行（無ければ 204）。 */
    @GetMapping("/notice")
    public ResponseEntity<RetentionRun> notice() {
        RetentionRun r = service.notice();
        return r == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(r);
    }

    @PostMapping("/notice/ack")
    public void ack() {
        service.ackNotice();
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
