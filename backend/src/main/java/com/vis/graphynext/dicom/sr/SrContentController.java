/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.sr;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;

/**
 * SR の内容の木（SeriesViewer の SR 表示用・読み取り専用）。
 *
 * <p>{@code GET /api/studies/{study}/series/{series}/instances/{sop}/sr}。Tag Viewer の
 * {@code .../tags} と同じ流儀で、web は WADO-RS で取得したバイト列、standalone は索引のファイルを読む。
 * SR でない・壊れているときは、理由つきの 4xx を返す（例外を握りつぶして空を返さない）。
 */
@RestController
public class SrContentController {

    private static final Logger log = LoggerFactory.getLogger(SrContentController.class);

    private final DicomStorageService storage;
    private final ObjectProvider<WebDicomDataService> webProvider;

    public SrContentController(DicomStorageService storage, ObjectProvider<WebDicomDataService> webProvider) {
        this.storage = storage;
        this.webProvider = webProvider;
    }

    @GetMapping("/api/studies/{studyUid}/series/{seriesUid}/instances/{sopUid}/sr")
    public ResponseEntity<?> sr(@PathVariable String studyUid, @PathVariable String seriesUid, @PathVariable String sopUid) {
        Attributes ds;
        try {
            WebDicomDataService web = webProvider.getIfAvailable();
            if (web != null) {
                byte[] bytes = web.retrieveInstance(studyUid, seriesUid, sopUid);
                if (bytes == null || bytes.length == 0) {
                    return notFound();
                }
                ds = readDataset(new DicomInputStream(new ByteArrayInputStream(bytes)));
            } else {
                Path file = storage.resolveInstanceFile(sopUid);
                if (file == null) {
                    return notFound();
                }
                try (DicomInputStream in = new DicomInputStream(file.toFile())) {
                    ds = readDataset(in);
                }
            }
        } catch (IOException e) {
            log.warn("sr: 読み取り失敗 sop={}", sopUid, e);
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(Map.of("error", "DICOM として読めません"));
        }
        try {
            return ResponseEntity.ok(SrContentReader.read(ds));
        } catch (SrContentReader.NotSrException e) {
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(Map.of("error", e.getMessage()));
        }
    }

    private static Attributes readDataset(DicomInputStream in) throws IOException {
        try (in) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDataset();
        }
    }

    private static ResponseEntity<Map<String, String>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "インスタンスが見つかりません"));
    }
}
