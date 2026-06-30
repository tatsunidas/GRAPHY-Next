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
        ExportService.BuildResult result = service.buildZip(req.selections(), opts);
        Path zip = result.zip();
        long size = Files.size(zip);
        String filename = exportFilename(result.patientIds());

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
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .header(HttpHeaders.CONTENT_LENGTH, String.valueOf(size))
                .body(body);
    }

    /**
     * 保存ファイル名末尾に患者 ID を含める。1 名なら {@code graphy-export_<pid>.zip}、
     * 複数なら {@code graphy-export_<pid>_+N.zip}。ファイル名に使えない文字は {@code _} へ置換。
     */
    static String exportFilename(List<String> patientIds) {
        List<String> clean = patientIds == null ? List.of()
                : patientIds.stream()
                        .filter(p -> p != null && !p.isBlank())
                        .map(ExportController::sanitize)
                        .filter(s -> !s.isEmpty())
                        .toList();
        if (clean.isEmpty()) {
            return "graphy-export.zip";
        }
        if (clean.size() == 1) {
            return "graphy-export_" + clean.get(0) + ".zip";
        }
        return "graphy-export_" + clean.get(0) + "_+" + (clean.size() - 1) + ".zip";
    }

    private static String sanitize(String s) {
        // ファイル名・ヘッダで安全な文字のみ残す（ASCII 英数字と . _ -）
        String t = s.replaceAll("[^0-9A-Za-z._-]", "_");
        return t.length() <= 64 ? t : t.substring(0, 64);
    }
}
