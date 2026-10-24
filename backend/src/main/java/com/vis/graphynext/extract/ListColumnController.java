/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * スタディ一覧・シリーズ一覧に足したタグ列の値（読むだけ。値は DICOM ファイルにも索引にも書かない）。
 *
 * <ul>
 *   <li>{@code POST /api/studies/columns} … 表示中のスタディごと、列ごとのセル（シリーズごとの値を重複なしでまとめる）。</li>
 *   <li>{@code POST /api/studies/{uid}/series/columns} … そのスタディのシリーズごと、列ごとのセル。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/studies")
public class ListColumnController {

    /** 1 回の問い合わせで受けるスタディ数の上限（一覧の 1 ページは 50 件）。 */
    static final int MAX_STUDIES = 200;
    /** 1 回の問い合わせで受ける列数の上限。 */
    static final int MAX_COLUMNS = 50;

    private final ListColumnService service;

    public ListColumnController(ListColumnService service) {
        this.service = service;
    }

    public record StudiesRequest(List<String> studyUids, List<ListColumnService.Column> columns) {
    }

    public record SeriesRequest(List<ListColumnService.Column> columns) {
    }

    @PostMapping("/columns")
    public ResponseEntity<Map<String, Map<String, ListColumnService.Cell>>> studies(@RequestBody StudiesRequest req) {
        if (req.studyUids() == null || req.studyUids().size() > MAX_STUDIES || !validColumns(req.columns())) {
            return ResponseEntity.badRequest().build();
        }
        return ResponseEntity.ok(service.studyCells(req.studyUids(), req.columns()));
    }

    @PostMapping("/{uid}/series/columns")
    public ResponseEntity<Map<String, Map<String, ListColumnService.Cell>>> series(
            @PathVariable("uid") String uid, @RequestBody SeriesRequest req) {
        if (uid == null || uid.isBlank() || !validColumns(req.columns())) {
            return ResponseEntity.badRequest().build();
        }
        return ResponseEntity.ok(service.seriesCells(uid, req.columns()));
    }

    private static boolean validColumns(List<ListColumnService.Column> columns) {
        if (columns == null || columns.size() > MAX_COLUMNS) {
            return false;
        }
        for (ListColumnService.Column c : columns) {
            if (c == null || c.id() == null || c.id().isBlank() || c.segments() == null || c.segments().isEmpty()) {
                return false;
            }
        }
        return true;
    }
}
