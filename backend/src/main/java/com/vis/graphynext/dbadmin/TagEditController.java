/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 任意の DICOM タグの編集（standalone のローカル保管庫だけ。web は PACS の値を書き換える標準の手段が無いので読むだけ）。
 * 決まりに合わない編集は 400 で、行ごとの理由（{@code problems}）を返す。
 */
@RestController
@Profile("standalone")
public class TagEditController {

    private final TagEditService service;

    public TagEditController(TagEditService service) {
        this.service = service;
    }

    public record Request(TagEditService.Scope scope, List<TagEditService.Edit> edits) {
    }

    /** 書かずに、範囲の画像数と「今の値が見えていた値と異なる」画像数を返す。 */
    @PostMapping("/api/dbadmin/tags/preview")
    public TagEditService.Preview preview(@RequestBody Request req) {
        return service.preview(req.scope(), req.edits());
    }

    @PostMapping("/api/dbadmin/tags/apply")
    public TagEditService.Result apply(@RequestBody Request req) {
        return service.apply(req.scope(), req.edits());
    }

    @ExceptionHandler(TagEditService.InvalidEditException.class)
    public ResponseEntity<Map<String, Object>> invalid(TagEditService.InvalidEditException e) {
        return ResponseEntity.badRequest().body(Map.of("error", "invalid-tag-edit", "problems", e.problems()));
    }
}
