/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.sr;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;

/**
 * 計測レポート（DICOM SR）の生成エンドポイント。
 *
 * <p>{@code POST /api/sr/measurement-report} … 計測を SR として保管庫へ保存し、
 * 新 SeriesInstanceUID / SOPInstanceUID を返す。
 *
 * <p>DICOM の構造は本体が作る（呼び出し側は「何を測ったか」だけを渡す）。
 */
@RestController
@RequestMapping("/api/sr")
public class MeasurementReportController {

    private final MeasurementReportService service;

    public MeasurementReportController(MeasurementReportService service) {
        this.service = service;
    }

    @PostMapping("/measurement-report")
    public MeasurementReportService.Result create(@RequestBody MeasurementReportRequest req) {
        try {
            return service.create(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "SR の保存に失敗しました: " + e.getMessage(), e);
        }
    }
}
