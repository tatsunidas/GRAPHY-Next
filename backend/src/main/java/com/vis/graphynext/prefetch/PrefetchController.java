/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Map;

/** 事前取得の状態・記録・手動実行（standalone のみ。web モードではこのクラスも Bean も無く 404）。設定は設定 API で保存する。 */
@RestController
@Profile("standalone")
@RequestMapping("/api/prefetch")
public class PrefetchController {

    public record RunDto(long id, String slotKey, String trigger, long startedAt, Long finishedAt, String status,
                         String targetDays, int patients, int found, int retrieved, int existing, int failed,
                         int pending, String error) {
        static RunDto of(PrefetchRun r) {
            return new RunDto(r.getId(), r.getSlotKey(), r.getTriggerKind(), r.getStartedAt(), r.getFinishedAt(),
                    r.getStatus(), r.getTargetDays(), r.getPatients(), r.getFound(), r.getRetrieved(), r.getExisting(),
                    r.getFailed(), r.getPending(), r.getError());
        }
    }

    public record ItemDto(String studyUid, String status, String error) {
    }

    public record StatusDto(boolean enabled, boolean valid, List<String> errors, boolean running, List<RunDto> runs) {
    }

    private final PrefetchService service;

    public PrefetchController(PrefetchService service) {
        this.service = service;
    }

    @GetMapping("/status")
    public StatusDto status() {
        PrefetchConfig c = service.config();
        return new StatusDto(c.enabled(), c.valid(), c.errors(), service.isRunning(),
                service.recentRuns().stream().map(RunDto::of).toList());
    }

    /** 手動実行（設定が有効なときだけ。走行中は 409）。 */
    @PostMapping("/run")
    public RunDto run() {
        try {
            return RunDto.of(service.run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL));
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "running");
        }
    }

    /** 予約一覧だけ取って、日ごとの患者数を返す（取得はしない）。 */
    @PostMapping("/preview-schedule")
    public Map<String, Integer> preview() {
        try {
            return service.previewSchedule();
        } catch (PrefetchService.SourceException e) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, e.getMessage());
        }
    }

    @GetMapping("/runs/{id}/items")
    public List<ItemDto> items(@PathVariable long id) {
        return service.itemsOf(id).stream().map(i -> new ItemDto(i.getStudyUid(), i.getStatus(), i.getError())).toList();
    }
}
