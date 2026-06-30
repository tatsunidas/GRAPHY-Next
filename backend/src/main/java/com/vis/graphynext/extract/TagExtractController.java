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
 * TagExtractor: 指定タグ群を CSV/JSON で一括抽出して返す（ダウンロード用）。
 *
 * <p>{@code POST /api/extract/tags} にスコープ（studyUid 必須、seriesUid 任意）と
 * tags（16 進タグ番号の配列）、format（csv|json）を渡す。レスポンスは
 * {@code Content-Disposition: attachment} 付きでフロントがそのまま保存できる。
 */
@RestController
@RequestMapping("/api/extract")
public class TagExtractController {

    private static final MediaType TEXT_CSV = MediaType.parseMediaType("text/csv; charset=UTF-8");

    private final TagExtractService service;

    public TagExtractController(TagExtractService service) {
        this.service = service;
    }

    /** リクエスト本文。 */
    public record TagExtractRequest(String studyUid, String seriesUid, List<String> tags, String format) {}

    @PostMapping("/tags")
    public ResponseEntity<byte[]> extract(@RequestBody TagExtractRequest req) {
        if (req.studyUid() == null || req.studyUid().isBlank()
                || req.tags() == null || req.tags().isEmpty()) {
            return ResponseEntity.badRequest().build();
        }
        TagExtractService.ExtractResult result = service.extract(req.studyUid(), req.seriesUid(), req.tags());
        boolean json = "json".equalsIgnoreCase(req.format());
        String body = json ? TagExtractFormat.toJson(result) : TagExtractFormat.toCsv(result);
        String filename = "tags-" + shortId(req.studyUid()) + (json ? ".json" : ".csv");
        return ResponseEntity.ok()
                .contentType(json ? MediaType.APPLICATION_JSON : TEXT_CSV)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .body(body.getBytes(StandardCharsets.UTF_8));
    }

    private static String shortId(String uid) {
        String s = uid.replaceAll("[^0-9A-Za-z]", "");
        return s.length() <= 12 ? s : s.substring(s.length() - 12);
    }
}
