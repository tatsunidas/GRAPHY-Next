/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.util.List;

/**
 * SeriesExtractor REST: 条件一致シリーズの検証・コピー・ZIP。
 *
 * <ul>
 *   <li>{@code POST /api/series-extract/verify} → 一致プレビュー（VerifyResult）。</li>
 *   <li>{@code POST /api/series-extract/copy} → standalone でフォルダコピー（CopyResult）。</li>
 *   <li>{@code POST /api/series-extract/zip} → standalone のローカルファイルを ZIP で返す。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/series-extract")
public class SeriesExtractController {

    private final SeriesExtractService service;

    public SeriesExtractController(SeriesExtractService service) {
        this.service = service;
    }

    /** リクエスト本文。destination/sequentialRename は copy/zip 用。 */
    public record ExtractReq(List<String> studyUids, List<SearchCondition> conditions, List<String> planes,
                             String destination, boolean sequentialRename) {
    }

    @PostMapping("/verify")
    public SeriesExtractService.VerifyResult verify(@RequestBody ExtractReq req) {
        if (req.studyUids() == null || req.studyUids().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "studyUids が空です");
        }
        return service.verify(req.studyUids(), conds(req), req.planes());
    }

    @PostMapping("/copy")
    public ResponseEntity<SeriesExtractService.CopyResult> copy(@RequestBody ExtractReq req) {
        if (req.studyUids() == null || req.studyUids().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "studyUids が空です");
        }
        try {
            return ResponseEntity.ok(service.copyToFolder(
                    req.studyUids(), conds(req), req.planes(), req.destination(), req.sequentialRename()));
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }
    }

    @PostMapping("/zip")
    public ResponseEntity<StreamingResponseBody> zip(@RequestBody ExtractReq req) {
        if (req.studyUids() == null || req.studyUids().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "studyUids が空です");
        }
        if (service.isWeb()) {
            // web の ZIP は WADO-RS 取得が必要（未実装）。
            throw new ResponseStatusException(HttpStatus.NOT_IMPLEMENTED,
                    "web モードの ZIP（WADO-RS 取得）は未対応です。standalone をご利用ください。");
        }
        StreamingResponseBody body = out -> {
            try {
                service.zipLocal(req.studyUids(), conds(req), req.planes(), req.sequentialRename(), out);
            } catch (Exception e) {
                throw new java.io.IOException(e);
            }
        };
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/zip"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"series-extract.zip\"")
                .body(body);
    }

    private static List<SearchCondition> conds(ExtractReq req) {
        return req.conditions() == null ? List.of() : req.conditions();
    }
}
