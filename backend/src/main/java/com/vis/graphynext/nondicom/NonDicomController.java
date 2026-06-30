/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nondicom;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * NonDicomImporter: 非 DICOM（PDF / 一般画像 / 動画）を DICOM 化して取り込む。
 *
 * <p>{@code POST /api/import/nondicom}。本文に紐付け情報（患者/スタディ）とファイルパスを渡す。
 * standalone（ローカル FS アクセス）前提。
 */
@RestController
@RequestMapping("/api/import")
public class NonDicomController {

    private final NonDicomImportService service;

    public NonDicomController(NonDicomImportService service) {
        this.service = service;
    }

    @PostMapping("/nondicom")
    public ResponseEntity<NonDicomImportService.Result> nondicom(@RequestBody NonDicomImportService.Request req) {
        if (req == null || req.paths() == null || req.paths().isEmpty()
                || req.patientId() == null || req.patientId().isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        return ResponseEntity.ok(service.importFiles(req));
    }
}
