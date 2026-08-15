/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;

/**
 * アンギオの解析結果を DICOM オブジェクトとして保存する API（{@code fw/angio-design.md} §14 / A10）。
 *
 * <ul>
 *   <li>{@code POST /api/angio/presentation-state} … XA/XRF GSPS（DSA 設定・VOI・計測描画・空間校正）</li>
 *   <li>{@code POST /api/angio/qca-sr} … QCA 計測値の Comprehensive SR</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/angio")
public class AngioController {

    private static final Logger log = LoggerFactory.getLogger(AngioController.class);

    private final AngioStoreService service;

    public AngioController(AngioStoreService service) {
        this.service = service;
    }

    @PostMapping("/presentation-state")
    public ResponseEntity<AngioStoreService.Created> createPresentationState(
            @RequestBody AngioPresentationRequest req) {
        requireText(req.sopInstanceUid(), "sopInstanceUid");
        requireText(req.seriesInstanceUid(), "seriesInstanceUid");
        try {
            return ResponseEntity.ok(service.createPresentationState(req));
        } catch (IOException e) {
            log.error("GSPS の作成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "表示状態を保存できませんでした");
        }
    }

    @PostMapping("/qca-sr")
    public ResponseEntity<AngioStoreService.Created> createQcaSr(@RequestBody QcaSrRequest req) {
        requireText(req.sopInstanceUid(), "sopInstanceUid");
        try {
            return ResponseEntity.ok(service.createQcaSr(req));
        } catch (IOException e) {
            log.error("QCA SR の作成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "解析結果を保存できませんでした");
        }
    }

    @PostMapping("/qlv-sr")
    public ResponseEntity<AngioStoreService.Created> createQlvSr(@RequestBody QlvSrRequest req) {
        requireText(req.sopInstanceUid(), "sopInstanceUid");
        try {
            return ResponseEntity.ok(service.createQlvSr(req));
        } catch (IOException e) {
            log.error("QLV SR の作成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "解析結果を保存できませんでした");
        }
    }

    private static void requireText(String v, String name) {
        if (v == null || v.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, name + " は必須です");
        }
    }
}
