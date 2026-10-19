/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** フォルダ出力のエクスポートジョブ API（standalone だけ）。Web 版は従来の {@code POST /api/export/zip}。 */
@RestController
@RequestMapping("/api/export/jobs")
@Profile("standalone")
public class ExportJobController {

    /** @param includePortableViewer 2D Viewer を同梱する（DICOMDIR・README も付く）。@param zip ZIP にまとめる。 */
    public record JobRequest(List<ExportService.Selection> selections, boolean includePortableViewer, boolean zip,
                             String destination) {}

    private final ExportJobService service;

    public ExportJobController(ExportJobService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<ExportJobService.Status> submit(@RequestBody JobRequest req) {
        if (req == null || req.selections() == null || req.selections().isEmpty()
                || req.selections().stream().allMatch(s -> s == null || s.seriesUids() == null || s.seriesUids().isEmpty())) {
            return ResponseEntity.badRequest().build();
        }
        try {
            return ResponseEntity.ok(service.submit(req.selections(), req.includePortableViewer(), req.zip(), req.destination()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping("/{jobId}")
    public ResponseEntity<ExportJobService.Status> get(@PathVariable String jobId) {
        ExportJobService.Status s = service.get(jobId);
        return s == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(s);
    }

    @PostMapping("/{jobId}/cancel")
    public ResponseEntity<ExportJobService.Status> cancel(@PathVariable String jobId) {
        ExportJobService.Status s = service.cancel(jobId);
        return s == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(s);
    }
}
