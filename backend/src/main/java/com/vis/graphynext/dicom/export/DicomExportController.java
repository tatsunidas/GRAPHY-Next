/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.List;

/**
 * ROI/マスクの DICOM 書き出しエンドポイント。マスク→DICOM SEG（S1）、ROI→RTSTRUCT（S2）。
 * 生成した DICOM は standalone のローカル保管庫に取り込み、新シリーズとして返す
 * （設計 {@code fw/dicom-seg-rtstruct-design.md}）。
 */
@RestController
@RequestMapping("/api/dicom")
public class DicomExportController {

    private final SegExportService segService;
    private final RtStructExportService rtStructService;
    private final RtStructReadService rtStructReadService;

    public DicomExportController(SegExportService segService, RtStructExportService rtStructService,
            RtStructReadService rtStructReadService) {
        this.segService = segService;
        this.rtStructService = rtStructService;
        this.rtStructReadService = rtStructReadService;
    }

    /** マスク群を DICOM SEG（BINARY）として保存し、新 Series/SOP UID を返す。 */
    @PostMapping("/seg")
    public SegExportService.Result exportSeg(@RequestBody SegExportRequest req) {
        try {
            return segService.export(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "DICOM SEG の保存に失敗しました: " + e.getMessage(), e);
        }
    }

    /** 2D ベクタ ROI 群を DICOM RT Structure Set として保存し、新 Series/SOP UID を返す。 */
    @PostMapping("/rtstruct")
    public RtStructExportService.Result exportRtStruct(@RequestBody RtStructExportRequest req) {
        try {
            return rtStructService.export(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "RTSTRUCT の保存に失敗しました: " + e.getMessage(), e);
        }
    }

    /** 指定 RTSTRUCT シリーズを読み、ROI 輪郭（患者座標 mm）を返す（frontend が ROI へ復元）。 */
    @GetMapping("/rtstruct")
    public List<RtStructRoiDto> readRtStruct(@RequestParam("study") String studyUid,
            @RequestParam("series") String seriesUid) {
        try {
            return rtStructReadService.read(studyUid, seriesUid);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "RTSTRUCT の読込に失敗しました: " + e.getMessage(), e);
        }
    }
}
