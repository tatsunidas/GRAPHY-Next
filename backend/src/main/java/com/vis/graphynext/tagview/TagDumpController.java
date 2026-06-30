/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.tagview;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * TagViewer: 単一インスタンスの DICOM 属性ダンプ（Read only）。
 *
 * <p>{@code GET /api/instances/{sop}/tags} → {@link TagDumpService.TagRow} の配列。
 * standalone のローカル索引にあるファイルのみ対象（web/WADO は将来対応）。
 */
@RestController
@RequestMapping("/api/instances")
public class TagDumpController {

    private final TagDumpService service;

    public TagDumpController(TagDumpService service) {
        this.service = service;
    }

    @GetMapping("/{sopUid}/tags")
    public ResponseEntity<List<TagDumpService.TagRow>> tags(@PathVariable String sopUid) {
        List<TagDumpService.TagRow> rows = service.dump(sopUid);
        if (rows == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(rows);
    }
}
