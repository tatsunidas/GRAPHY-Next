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
 * standalone のローカル索引にあるファイルのみ対象。web では索引が無いため常に 404 になる。
 * web でも動く入口は {@code GET /api/studies/{study}/series/{series}/instances/{sop}/tags}
 * （{@link com.vis.graphynext.dicom.StudyController#instanceTags}）を使うこと。
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
