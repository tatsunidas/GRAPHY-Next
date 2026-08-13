/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * GLAM 解析のエンドポイント。
 *
 * <p>解析そのもの（{@code POST /analyze}）と、<b>任意の</b>保存（{@code /saved}）を分けている。
 * 解析は ROI が同じなら何度でも同じ数値になるので、常に残す必要は無い。残すかどうかは
 * 利用者が決める。
 */
@RestController
@RequestMapping("/api/radiomics/glam")
public class GlamAnalysisController {

    private final GlamAnalysisService service;
    private final GlamAnalysisDocumentRepository repository;
    private final ObjectMapper mapper;

    public GlamAnalysisController(GlamAnalysisService service, GlamAnalysisDocumentRepository repository,
                                  ObjectMapper mapper) {
        this.service = service;
        this.repository = repository;
        this.mapper = mapper;
    }

    /** ROI 全体で GLAM を計算して記述子を返す（保存はしない）。 */
    @PostMapping("/analyze")
    public GlamAnalysis analyze(@RequestBody GlamAnalysisRequest req) {
        try {
            return service.analyze(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "GLAM 解析に失敗しました", e);
        }
    }

    /** 保存された解析の一覧（study 単位、新しい順）。JSON 本体は含めない。 */
    @GetMapping("/saved")
    public List<SavedSummary> list(@RequestParam String studyInstanceUid) {
        return repository.findByStudyInstanceUidOrderBySavedAtDesc(studyInstanceUid).stream()
                .map(d -> new SavedSummary(d.getId(), d.getLabel(), d.getSourceSeriesUid(), d.getMaskSeriesUid(),
                        d.getNBins(), d.getMaxRadius(), d.getRoiVoxelCount(), d.getSavedAt()))
                .toList();
    }

    /** 保存された解析を読み出す。 */
    @GetMapping("/saved/{id}")
    public GlamAnalysis load(@PathVariable String id) {
        GlamAnalysisDocument doc = repository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "保存された解析がありません: " + id));
        try {
            return mapper.readValue(doc.getJson(), GlamAnalysis.class);
        } catch (JsonProcessingException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "保存された解析を読めません", e);
        }
    }

    /** 解析結果を保存する（利用者が保存を選んだときだけ呼ばれる）。 */
    @PostMapping("/saved")
    public SavedSummary save(@RequestBody SaveRequest req) {
        if (req.analysis() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "analysis は必須です");
        }
        String json;
        try {
            json = mapper.writeValueAsString(req.analysis());
        } catch (JsonProcessingException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "analysis を JSON にできません", e);
        }
        String label = (req.label() == null || req.label().isBlank()) ? "GLAM analysis" : req.label().trim();
        GlamAnalysisDocument doc = new GlamAnalysisDocument(UUID.randomUUID().toString(),
                req.studyInstanceUid(), req.sourceSeriesUid(), req.maskSeriesUid(), label, json,
                req.analysis().nBins(), req.analysis().maxRadius(), req.analysis().roiVoxelCount());
        repository.save(doc);
        return new SavedSummary(doc.getId(), doc.getLabel(), doc.getSourceSeriesUid(), doc.getMaskSeriesUid(),
                doc.getNBins(), doc.getMaxRadius(), doc.getRoiVoxelCount(), doc.getSavedAt());
    }

    /** 保存された解析を消す。 */
    @DeleteMapping("/saved/{id}")
    public void delete(@PathVariable String id) {
        repository.deleteById(id);
    }

    /** 一覧の 1 行（JSON 本体は含めない）。 */
    public record SavedSummary(String id, String label, String sourceSeriesUid, String maskSeriesUid,
                               int nBins, int maxRadius, long roiVoxelCount, Instant savedAt) {
    }

    /** 保存要求。 */
    public record SaveRequest(String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                              String label, GlamAnalysis analysis) {
    }
}
