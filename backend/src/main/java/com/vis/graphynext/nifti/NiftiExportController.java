/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import com.vis.graphynext.anonymize.AnonymizeJobService;
import com.vis.graphynext.compute.ComputeDatasetService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
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
    /** web モードだけにある（PACS から取るので時間がかかるためジョブにする。standalone は直接返す）。 */
    private final ObjectProvider<AnonymizeJobService> webJobs;

    public NiftiExportController(ComputeDatasetService datasets) {
        this(datasets, null);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public NiftiExportController(ComputeDatasetService datasets, ObjectProvider<AnonymizeJobService> webJobs) {
        this.datasets = datasets;
        this.webJobs = webJobs;
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
        return ResponseEntity.ok()
                .contentType(GZIP)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + name + "\"")
                .header(HttpHeaders.CONTENT_LENGTH, String.valueOf(d.bytes()))
                .header("X-Graphy-Slices", String.valueOf(d.instances()))
                .body(body);
    }

    /**
     * web: ジョブにして 202 と状態を返す（PACS から 1 枚ずつ取るので時間がかかる）。状態の確認・中止は
     * {@code /api/anonymizer/jobs/{id}}（GET・DELETE）、受け取りは {@link #webFile}。standalone では使えない（501）。
     * ⚠ {@code /export} と戻り値の型を分ける（{@code ResponseEntity<?>} は実アプリで 500 になった。段 1a の発見）。
     */
    @PostMapping("/export-job")
    public ResponseEntity<AnonymizeJobService.Status> exportJob(@RequestBody ExportRequest req) throws Exception {
        if (req == null || blank(req.studyUid()) || blank(req.seriesUid())) {
            throw new Refusal(HttpStatus.BAD_REQUEST, "bad-request");
        }
        AnonymizeJobService jobs = webJobs == null ? null : webJobs.getIfAvailable();
        if (jobs == null) {
            throw new Refusal(HttpStatus.NOT_IMPLEMENTED, "not-web-mode");
        }
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(jobs.submitNifti(req.studyUid(), req.seriesUid()));
    }

    /** web: 終わったジョブの NIfTI を渡す。⚠ 受け取れるのは 1 回だけ（渡し終えるとジョブごと消える）。 */
    @GetMapping("/export-job/{id}/file")
    public ResponseEntity<StreamingResponseBody> webFile(@PathVariable String id) throws Exception {
        AnonymizeJobService jobs = webJobs == null ? null : webJobs.getIfAvailable();
        AnonymizeJobService.Status st = jobs == null ? null : jobs.status(id);
        if (st == null) {
            throw new Refusal(HttpStatus.NOT_FOUND, "job-not-found");
        }
        java.nio.file.Path file = jobs.niftiOf(id);
        if (file == null) {
            throw new Refusal(HttpStatus.CONFLICT, "job-not-ready");
        }
        long bytes = Files.size(file);
        StreamingResponseBody body = out -> {
            try {
                Files.copy(file, out);
            } finally {
                jobs.discard(id);
            }
        };
        return ResponseEntity.ok()
                .contentType(GZIP)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"volume.nii.gz\"")
                .header(HttpHeaders.CONTENT_LENGTH, String.valueOf(bytes))
                .header("X-Graphy-Slices", String.valueOf(st.slices()))
                .body(body);
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
