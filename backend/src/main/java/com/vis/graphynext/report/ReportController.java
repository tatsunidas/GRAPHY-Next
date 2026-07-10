/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * レポート REST（`fw/report-design.md` R1: データモデル＋CRUD、R2: 確定/SR化）。
 *
 * <ul>
 *   <li>{@code GET /api/reports?studyUid=|patientId=} … 一覧（要約）</li>
 *   <li>{@code GET /api/reports/study-counts?studyUids=a,b} … MainScreen 一覧用の件数集計</li>
 *   <li>{@code GET /api/reports/{id}} … 詳細（本文・参加者・キー画像を含む）</li>
 *   <li>{@code POST /api/reports} … 新規下書き作成</li>
 *   <li>{@code PUT /api/reports/{id}} … 下書き保存（本文/参加者/キー画像）</li>
 *   <li>{@code DELETE /api/reports/{id}} … 下書き削除（確定済みは 409）</li>
 *   <li>{@code POST /api/reports/{id}/lock} / {@code /unlock} … 編集ロック</li>
 *   <li>{@code POST /api/reports/{id}/finalize} … Comprehensive SR として確定</li>
 * </ul>
 *
 * <p>KO（Key Object Selection）生成はフェーズ3で追加する。
 */
@RestController
@RequestMapping("/api/reports")
public class ReportController {

    private final ReportService service;

    public ReportController(ReportService service) {
        this.service = service;
    }

    @GetMapping
    public List<ReportSummaryDto> list(
            @RequestParam(required = false) String studyUid,
            @RequestParam(required = false) String patientId) {
        if (studyUid != null && !studyUid.isBlank()) {
            return service.listByStudy(studyUid);
        }
        if (patientId != null && !patientId.isBlank()) {
            return service.listByPatient(patientId);
        }
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "studyUid または patientId が必要です");
    }

    @GetMapping("/study-counts")
    public List<StudyReportCountDto> studyCounts(@RequestParam String studyUids) {
        List<String> ids = new ArrayList<>();
        for (String s : studyUids.split(",")) {
            if (!s.isBlank()) {
                ids.add(s.trim());
            }
        }
        return service.studyCounts(ids);
    }

    @GetMapping("/{id}")
    public ReportDto get(@PathVariable String id) {
        return service.get(id);
    }

    @PostMapping
    public ReportDto create(@RequestBody CreateReportRequest req) {
        return service.create(req);
    }

    @PutMapping("/{id}")
    public ReportDto update(@PathVariable String id, @RequestBody UpdateReportRequest req) {
        return service.update(id, req);
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable String id) {
        service.delete(id);
    }

    @PostMapping("/{id}/lock")
    public ReportDto lock(@PathVariable String id, @RequestBody LockRequest req) {
        return service.lock(id, req.lockedBy());
    }

    @PostMapping("/{id}/unlock")
    public ReportDto unlock(@PathVariable String id, @RequestBody LockRequest req) {
        return service.unlock(id, req.lockedBy());
    }

    @PostMapping("/{id}/finalize")
    public ReportDto finalizeReport(@PathVariable String id) {
        try {
            return service.finalizeReport(id);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "SR の保存に失敗しました: " + e.getMessage(), e);
        }
    }

    public record LockRequest(String lockedBy) {
    }
}
