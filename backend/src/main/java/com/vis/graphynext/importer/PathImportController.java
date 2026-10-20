/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * ローカル取り込みのジョブ API（進捗と中止つき）。同期版 {@code POST /api/import/paths} は残してある。
 * サーバー上のパスを受けるので standalone だけ（{@link ImportController} と同じ）。
 */
@RestController
@RequestMapping("/api/import/paths/jobs")
@Profile("standalone")
public class PathImportController {

    private final PathImportJobService service;

    public PathImportController(PathImportJobService service) {
        this.service = service;
    }

    @PostMapping
    public PathImportJobService.Status submit(@RequestBody ImportController.ImportRequest req) {
        return service.submit(req == null ? null : req.paths());
    }

    @GetMapping("/{jobId}")
    public ResponseEntity<PathImportJobService.Status> get(@PathVariable String jobId) {
        PathImportJobService.Status s = service.get(jobId);
        return s == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(s);
    }

    @PostMapping("/{jobId}/cancel")
    public ResponseEntity<PathImportJobService.Status> cancel(@PathVariable String jobId) {
        PathImportJobService.Status s = service.cancel(jobId);
        return s == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(s);
    }
}
