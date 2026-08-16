/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * NIfTI インポートの REST 入口。
 *
 * <p><b>パス指定</b>にしてある（アップロードではない）。4D の NIfTI は数百 MB になることがあり、
 * multipart で送ると一時領域を二重に使うため。既存の非 DICOM インポート
 * （{@code /api/import/nondicom}）と同じく <b>standalone のローカル FS 前提</b>。
 *
 * <ul>
 *   <li>{@code POST /api/nifti/probe} … ヘッダだけ読んで次元・幾何の有無を返す
 *       （取り込み前に「向きが入っていない」ことをユーザーへ見せるため）</li>
 *   <li>{@code POST /api/nifti/import} … 変換して保管庫へ取り込む</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/nifti")
public class NiftiImportController {

    private static final Logger log = LoggerFactory.getLogger(NiftiImportController.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    private final NiftiImportService service;

    public NiftiImportController(NiftiImportService service) {
        this.service = service;
    }

    /** 下読みの要求。 */
    public record ProbeRequest(String path) {
    }

    /** ヘッダの下読み結果（取り込みはしない）。 */
    public record Probe(
            int columns, int rows, int slices, int phases, int channels,
            double spacingX, double spacingY, double spacingZ,
            int datatype, String pixelConversion,
            String geometrySource, boolean geometrySynthesized,
            String description, boolean supported, String error) {
    }

    /** 取り込みの要求。患者情報が空なら変換側が既定で埋める（**推測はしない**）。 */
    public record ImportRequest(
            String path,
            String metadataPath,
            String modality,
            String patientId,
            String patientName,
            String patientBirthDate,
            String patientSex,
            String studyDate,
            String studyDescription,
            String seriesDescription,
            Integer seriesNumber,
            String studyInstanceUid) {
    }

    @PostMapping("/probe")
    public ResponseEntity<Probe> probe(@RequestBody ProbeRequest req) {
        Path file = resolve(req == null ? null : req.path());
        if (file == null) {
            return ResponseEntity.badRequest().body(error("ファイルが見つかりません"));
        }
        try {
            NiftiHeader h = NiftiToDicom.readHeader(file);
            NiftiGeometry geom = NiftiGeometry.of(h);
            String conversion;
            boolean supported;
            try {
                conversion = NiftiToDicom.PixelSpec.of(h).description;
                supported = true;
            } catch (IOException e) {
                conversion = e.getMessage();
                supported = false;
            }
            return ResponseEntity.ok(new Probe(h.nx(), h.ny(), h.nz(), h.nt(), h.nc(),
                    h.spacingX() * h.spatialUnitToMm(), h.spacingY() * h.spatialUnitToMm(),
                    h.spacingZ() * h.spatialUnitToMm(), h.datatype, conversion,
                    geom.source, geom.synthesized, h.description, supported, null));
        } catch (IOException e) {
            return ResponseEntity.badRequest().body(error(e.getMessage()));
        }
    }

    @PostMapping("/import")
    public ResponseEntity<NiftiImportService.Result> importNifti(@RequestBody ImportRequest req) {
        Path file = resolve(req == null ? null : req.path());
        if (file == null) {
            return ResponseEntity.badRequest().build();
        }
        Map<String, Object> meta = readMetadata(req.metadataPath());
        NiftiToDicom.Options opts = new NiftiToDicom.Options(
                req.modality() == null ? "MR" : req.modality(),
                req.patientId(), req.patientName(), req.patientBirthDate(), req.patientSex(),
                req.studyDate(), req.studyDescription(), req.seriesDescription(),
                req.seriesNumber() == null ? 1 : req.seriesNumber(),
                req.studyInstanceUid(), null, meta);
        NiftiImportService.Result result = service.importFile(file, meta, opts);
        return result.error() == null ? ResponseEntity.ok(result) : ResponseEntity.badRequest().body(result);
    }

    /** サイドカー JSON を読む。壊れていても取り込みは続ける（属性が付かないだけ）。 */
    private static Map<String, Object> readMetadata(String path) {
        Path p = resolve(path);
        if (p == null) {
            return Map.of();
        }
        try {
            return JSON.readValue(p.toFile(), new TypeReference<Map<String, Object>>() { });
        } catch (IOException e) {
            log.warn("[nifti] サイドカー JSON を解釈できません: {}", e.getMessage());
            return Map.of();
        }
    }

    private static Path resolve(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }
        Path p = Path.of(path);
        return Files.isRegularFile(p) ? p : null;
    }

    private static Probe error(String message) {
        return new Probe(0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, false, null, false, message);
    }
}
