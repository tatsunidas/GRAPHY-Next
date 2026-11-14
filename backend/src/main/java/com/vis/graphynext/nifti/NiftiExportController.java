/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import com.vis.graphynext.compute.ComputeDatasetService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.nio.file.Files;
import java.util.Map;

/**
 * 1 シリーズを NIfTI-1（{@code .nii.gz}・float32）として書き出す（fw/nifti-import.md §10）。
 *
 * <p>{@code POST /api/nifti/export {studyUid, seriesUid}}。画素は匿名化の出力（焼き込みを塗った後）から取り、
 * 並べられない形・チルト・幾何が無い画像は<b>ファイルを流し始める前に</b> 422 と理由コードで断る
 * （200 の空ファイルを返さない）。書き出しは利用者のディスクへ渡るだけで、計算機には送らない。
 * ファイル名は患者情報を含まない既定名（画面側が系列番号などで付け直してよい）。
 */
@RestController
@RequestMapping("/api/nifti")
public class NiftiExportController {

    private static final Logger log = LoggerFactory.getLogger(NiftiExportController.class);
    private static final MediaType GZIP = MediaType.parseMediaType("application/gzip");

    private final ComputeDatasetService datasets;

    public NiftiExportController(ComputeDatasetService datasets) {
        this.datasets = datasets;
    }

    public record ExportRequest(String studyUid, String seriesUid) {
    }

    /** 断る（本体は流さない）。{@link #refused} が JSON にする。 */
    public static final class Refusal extends RuntimeException {
        private final HttpStatus status;

        Refusal(HttpStatus status, String reason) {
            super(reason);
            this.status = status;
        }

        public HttpStatus status() {
            return status;
        }

        public String reason() {
            return getMessage();
        }
    }

    @ExceptionHandler(Refusal.class)
    public ResponseEntity<Map<String, Object>> refused(Refusal e) {
        return ResponseEntity.status(e.status()).body(Map.of("ok", false, "error", e.reason()));
    }

    @PostMapping("/export")
    public ResponseEntity<StreamingResponseBody> export(@RequestBody ExportRequest req) throws Exception {
        if (req == null || blank(req.studyUid()) || blank(req.seriesUid())) {
            throw new Refusal(HttpStatus.BAD_REQUEST, "bad-request");
        }
        ComputeDatasetService.Dataset d;
        try {
            // localDestination=true: この PC の外へは出ない扱い（単純 X 線はマスク無しで通し、US・XA などはマスクが無ければ断る）
            d = datasets.create(req.studyUid(), req.seriesUid(), ComputeDatasetService.Format.NIFTI, true);
        } catch (ComputeDatasetService.DatasetRefused e) {
            throw new Refusal("web-mode".equals(e.reason()) ? HttpStatus.NOT_IMPLEMENTED : HttpStatus.UNPROCESSABLE_ENTITY,
                    e.reason());
        }
        String name = (d.modality() == null || d.modality().isBlank() ? "volume" : d.modality().replaceAll("[^A-Za-z0-9]", ""))
                + "_volume.nii.gz";
        StreamingResponseBody body = out -> {
            try {
                Files.copy(d.file(), out);
            } finally {
                datasets.discard(d.handle());
            }
        };
        log.info("[nifti] export series={} slices={} bytes={}", req.seriesUid(), d.instances(), d.bytes());
        ComputeDatasetService.NiftiInfo info = d.niftiInfo();
        int frames = info == null ? 1 : info.frames();
        // 時相の間隔（秒）。決まらないときは unknown／nonuniform（推測の値は返さない）。3D は none
        String timeStep = info == null ? "none"
                : "uniform".equals(info.timeStepStatus()) ? Double.toString(info.timeStepSec()) : info.timeStepStatus();
        return ResponseEntity.ok()
                .header("X-Graphy-Frames", String.valueOf(frames))
                .header("X-Graphy-Time-Step", timeStep)
                .contentType(GZIP)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + name + "\"")
                .header(HttpHeaders.CONTENT_LENGTH, String.valueOf(d.bytes()))
                .header("X-Graphy-Slices", String.valueOf(d.instances()))
                .body(body);
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
