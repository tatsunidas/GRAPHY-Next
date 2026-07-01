/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;

/**
 * 派生（セカンダリ）シリーズ生成エンドポイント。Slicer のリスライス結果を DICOM シリーズとして保存する。
 * standalone のローカル保管庫に取り込む（設計 {@code fw/slicer-design.md} §7）。
 */
@RestController
@RequestMapping("/api/series")
public class DerivedSeriesController {

    private final DerivedSeriesService service;

    public DerivedSeriesController(DerivedSeriesService service) {
        this.service = service;
    }

    /** 派生シリーズを生成・保存し、新 SeriesInstanceUID と SOPInstanceUID 一覧を返す。 */
    @PostMapping("/derived")
    public DerivedSeriesService.Result createDerived(@RequestBody DerivedSeriesRequest req) {
        try {
            return service.create(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "派生シリーズの保存に失敗しました: " + e.getMessage(), e);
        }
    }
}
