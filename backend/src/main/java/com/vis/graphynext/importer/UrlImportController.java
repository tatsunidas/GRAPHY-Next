/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * URL を指定した取り込み（fw/dicom-data-layer.md §4.4）。standalone だけ——web モードでサーバーに任意の URL を
 * 取りに行かせない（SSRF）。投入 → 問い合わせ → 中止のジョブ方式。
 */
@RestController
@RequestMapping("/api/import/url")
@Profile("standalone")
public class UrlImportController {

    private final UrlImportService service;

    public UrlImportController(UrlImportService service) {
        this.service = service;
    }

    public record SubmitRequest(String url) {
    }

    @PostMapping
    public ResponseEntity<?> submit(@RequestBody SubmitRequest req) {
        try {
            return ResponseEntity.ok(service.submit(req == null ? null : req.url()));
        } catch (UrlImportService.Refused e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/{jobId}")
    public ResponseEntity<UrlImportService.Status> get(@PathVariable String jobId) {
        UrlImportService.Status s = service.get(jobId);
        return s == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(s);
    }

    @PostMapping("/{jobId}/cancel")
    public ResponseEntity<UrlImportService.Status> cancel(@PathVariable String jobId) {
        UrlImportService.Status s = service.cancel(jobId);
        return s == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(s);
    }

    @DeleteMapping("/{jobId}/file")
    public ResponseEntity<Void> deleteFile(@PathVariable String jobId) {
        return service.deleteFile(jobId) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}
