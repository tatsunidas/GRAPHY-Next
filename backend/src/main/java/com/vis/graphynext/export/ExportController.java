/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Export: 選択シリーズを DICOM 交換メディア（PS3.10）形式の ZIP として配信する。
 *
 * <p>{@code POST /api/export/zip}。本文に {@link ExportService.Selection} の配列とオプションを渡す。
 * 一時 ZIP を生成し {@code Content-Disposition: attachment} でストリーム後に削除する。
 */
@RestController
@RequestMapping("/api/export")
public class ExportController {

    private static final Logger log = LoggerFactory.getLogger(ExportController.class);
    private static final MediaType ZIP = MediaType.parseMediaType("application/zip");

    private final ExportService service;

    public ExportController(ExportService service) {
        this.service = service;
    }

    /** リクエスト本文。 */
    public record ExportRequest(
            List<ExportService.Selection> selections,
            boolean includeDicomDir,
            boolean includePortableViewer,
            boolean includeReadme) {}

    @PostMapping("/zip")
    public ResponseEntity<StreamingResponseBody> zip(@RequestBody ExportRequest req) throws IOException {
        if (req.selections() == null || req.selections().isEmpty()
                || req.selections().stream().allMatch(s -> s.seriesUids() == null || s.seriesUids().isEmpty())) {
            return ResponseEntity.badRequest().build();
        }
        ExportService.Options opts = new ExportService.Options(
                req.includeDicomDir(), req.includePortableViewer(), req.includeReadme());
        Path zip = service.buildZip(req.selections(), opts);
        long size = Files.size(zip);

        StreamingResponseBody body = out -> {
            try {
                service.streamAndDelete(zip, out);
            } catch (IOException e) {
                log.warn("export: ストリーム中断", e);
                Files.deleteIfExists(zip);
                throw e;
            }
        };
        return ResponseEntity.ok()
                .contentType(ZIP)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"graphy-export.zip\"")
                .header(HttpHeaders.CONTENT_LENGTH, String.valueOf(size))
                .body(body);
    }
}
