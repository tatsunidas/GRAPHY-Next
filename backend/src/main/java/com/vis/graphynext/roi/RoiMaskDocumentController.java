/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.List;

/**
 * 塗り ROI（マスク）の保存 API。キーの {@code patientKey} は {@code /} を含み得るので、
 * {@link RoiDocumentController} と同じ理由でクエリで受ける。
 *
 * <p>画素は JSON に載せずバイナリ（multipart）で受ける。Jackson の文字列長の上限と、base64 の 33% 膨張を避けるため。
 */
@RestController
@RequestMapping("/api/roi-masks")
public class RoiMaskDocumentController {

    private final RoiMaskDocumentService service;

    public RoiMaskDocumentController(RoiMaskDocumentService service) {
        this.service = service;
    }

    @GetMapping
    public List<RoiMaskSummary> list(@RequestParam String patientKey) {
        return service.list(patientKey);
    }

    @GetMapping(value = "/{maskUid}/frames", produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public byte[] frames(@PathVariable String maskUid) {
        return service.frames(maskUid);
    }

    @PutMapping(value = "/{maskUid}", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public RoiMaskSummary save(
            @PathVariable String maskUid,
            @RequestParam String patientKey,
            @RequestParam String seriesUid,
            @RequestParam int frameCount,
            @RequestParam(required = false) Long version,
            @RequestPart("meta") String meta,
            @RequestPart("frames") MultipartFile frames) throws IOException {
        return service.save(maskUid, patientKey, seriesUid, meta, frames.getBytes(), frameCount, version);
    }

    @DeleteMapping("/{maskUid}")
    public ResponseEntity<Void> delete(@PathVariable String maskUid, @RequestParam String patientKey) {
        service.delete(maskUid, patientKey);
        return ResponseEntity.noContent().build();
    }
}
