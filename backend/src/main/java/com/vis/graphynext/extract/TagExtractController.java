/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * TagExtractor: タグ／シーケンス／Private を指定し、検索リスト全体をシリーズ単位で抽出する。
 *
 * <ul>
 *   <li>{@code POST /api/extract/table} … 画面テーブル用に {columns, rows, errors} を JSON で返す。</li>
 *   <li>{@code POST /api/extract/csv} … 同一リクエストで CSV（{@code Content-Disposition: attachment}）。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/extract")
public class TagExtractController {

    private static final MediaType TEXT_CSV = MediaType.parseMediaType("text/csv; charset=UTF-8");

    private final TagExtractService service;

    public TagExtractController(TagExtractService service) {
        this.service = service;
    }

    /** リクエスト本文。studyUids=検索リスト全体、paths=抽出するタグパス。 */
    public record ExtractRequest(List<String> studyUids, List<TagExtractService.TagPath> paths) {
    }

    @PostMapping("/table")
    public ResponseEntity<TagExtractService.TableResult> table(@RequestBody ExtractRequest req) {
        if (req.studyUids() == null || req.studyUids().isEmpty()
                || req.paths() == null) {
            return ResponseEntity.badRequest().build();
        }
        return ResponseEntity.ok(service.extractTable(req.studyUids(), req.paths()));
    }

    @PostMapping("/csv")
    public ResponseEntity<byte[]> csv(@RequestBody ExtractRequest req) {
        if (req.studyUids() == null || req.studyUids().isEmpty() || req.paths() == null) {
            return ResponseEntity.badRequest().build();
        }
        TagExtractService.TableResult result = service.extractTable(req.studyUids(), req.paths());
        String body = TagExtractFormat.toCsv(TagExtractService.toExtractResult(result));
        String filename = "tags-" + result.rows().size() + "rows.csv";
        return ResponseEntity.ok()
                .contentType(TEXT_CSV)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .body(body.getBytes(StandardCharsets.UTF_8));
    }
}
