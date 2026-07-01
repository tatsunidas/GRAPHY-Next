/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.imagej;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.List;

/**
 * ImageJ ROI 入出力 REST。
 *
 * <ul>
 *   <li>{@code POST /api/imagej/roiset} — DTO 配列を {@code RoiSet.zip} で配信（Export）。</li>
 *   <li>{@code POST /api/imagej/import} — {@code .roi}/{@code .zip} をアップロードし DTO 群で返す（Import）。</li>
 * </ul>
 * 座標は画像ピクセル系。フロント側で world ↔ 画素を変換する。
 */
@RestController
@RequestMapping("/api/imagej")
public class ImageJController {

    private static final Logger log = LoggerFactory.getLogger(ImageJController.class);
    private static final MediaType ZIP = MediaType.parseMediaType("application/zip");

    private final ImageJRoiService service;
    private final ImageJBridgeService bridge;

    public ImageJController(ImageJRoiService service, ImageJBridgeService bridge) {
        this.service = service;
        this.bridge = bridge;
    }

    /** ブリッジ要求本文。 */
    public record BridgeRequest(String studyUid, String seriesUid, String title) {}

    /** 表示中シリーズを ImageJ の HyperStack として開く（ローカル ImageJ 起動）。 */
    @PostMapping("/bridge")
    public ResponseEntity<ImageJBridgeService.BridgeResult> bridge(@RequestBody BridgeRequest req) {
        if (req == null || req.seriesUid() == null || req.seriesUid().isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        try {
            return ResponseEntity.ok(bridge.bridge(req.studyUid(), req.seriesUid(), req.title()));
        } catch (IllegalStateException e) {
            // headless など表示不可
            log.warn("[imagej] bridge unavailable: {}", e.getMessage());
            return ResponseEntity.status(409).build();
        } catch (Exception e) {
            log.warn("[imagej] bridge failed: {}", e.getMessage());
            return ResponseEntity.badRequest().build();
        }
    }

    /** ROI 群 → RoiSet.zip をダウンロード。 */
    @PostMapping("/roiset")
    public ResponseEntity<byte[]> roiset(@RequestBody List<ImageJRoiDto> rois) throws IOException {
        if (rois == null || rois.isEmpty()) return ResponseEntity.badRequest().build();
        byte[] zip = service.encodeRoiSet(rois);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"RoiSet.zip\"")
                .contentType(ZIP)
                .body(zip);
    }

    /** .roi/.zip をアップロード → DTO 群で返す。 */
    @PostMapping("/import")
    public ResponseEntity<List<ImageJRoiDto>> importRoi(@RequestParam("file") MultipartFile file) {
        if (file == null || file.isEmpty()) return ResponseEntity.badRequest().build();
        try {
            List<ImageJRoiDto> dtos = service.decode(file.getBytes(), file.getOriginalFilename());
            return ResponseEntity.ok(dtos);
        } catch (IOException e) {
            log.warn("[imagej] import failed: {}", e.getMessage());
            return ResponseEntity.badRequest().build();
        }
    }
}
