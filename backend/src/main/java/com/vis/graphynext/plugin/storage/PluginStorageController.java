/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.storage;

import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginRegistry;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * プラグインが手元に確保して読むための口（H62）。
 * <ul>
 *   <li>{@code POST /api/plugins/{id}/storage/ensure} — 検査（任意でシリーズ）を手元に確保するジョブを投入。
 *       状態・取り消しは {@code /api/plugin-jobs/{jobId}}（H45 と同じ）。</li>
 *   <li>{@code GET /api/plugins/{id}/storage/status} — モード・使用量・上限・Drive にだけある件数（読み取りのみ）。</li>
 * </ul>
 * パスは返さない。standalone 専用（web は 501）。
 */
@RestController
public class PluginStorageController {

    /** UID の長さの上限（DICOM の UID は 64 文字まで）。 */
    static final int MAX_UID = 64;
    /** 1 回の要求で指定できるシリーズの数。 */
    static final int MAX_SERIES = 1000;

    public record EnsureRequest(String studyUid, List<String> seriesUids) {
    }

    private final PluginRegistry registry;
    private final PluginJobService jobs;
    private final PluginStorageService service;

    public PluginStorageController(PluginRegistry registry, PluginJobService jobs, PluginStorageService service) {
        this.registry = registry;
        this.jobs = jobs;
        this.service = service;
    }

    @PostMapping("/api/plugins/{id}/storage/ensure")
    public ResponseEntity<Object> ensure(@PathVariable String id, @RequestBody EnsureRequest req) {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        String invalid = validate(req);
        if (invalid != null) return ResponseEntity.badRequest().body(Map.of("error", invalid));
        return ResponseEntity.ok(jobs.submitStorageTask(id, ctx -> service.ensure(req.studyUid(), req.seriesUids(), ctx)));
    }

    @GetMapping("/api/plugins/{id}/storage/status")
    public ResponseEntity<Object> status(@PathVariable String id) {
        Optional<ResponseEntity<Object>> denied = guard(id);
        if (denied.isPresent()) return denied.get();
        return ResponseEntity.ok(service.status());
    }

    /** 要求の形の検査。問題があれば理由、無ければ null。 */
    static String validate(EnsureRequest req) {
        if (req == null || req.studyUid() == null || req.studyUid().isBlank() || req.studyUid().length() > MAX_UID) {
            return "invalid-study-uid";
        }
        if (req.seriesUids() != null) {
            if (req.seriesUids().size() > MAX_SERIES) return "too-many-series";
            for (String s : req.seriesUids()) {
                if (s == null || s.isBlank() || s.length() > MAX_UID) return "invalid-series-uid";
            }
        }
        return null;
    }

    private Optional<ResponseEntity<Object>> guard(String id) {
        if (registry.manifests().stream().noneMatch(m -> id.equals(m.id()))) {
            return Optional.of(ResponseEntity.notFound().build());
        }
        if (!registry.localFilesAllowed()) {
            return Optional.of(ResponseEntity.status(501).body(Map.of("error", "desktop-only")));
        }
        return Optional.empty();
    }
}
