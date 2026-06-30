/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * standalone のローカル DB 管理 REST（患者テーブル・編集・削除・統計）。
 * web モードでは索引が空のため実質 standalone 専用。
 */
@RestController
public class DbAdminController {

    private final DbAdminService service;

    public DbAdminController(DbAdminService service) {
        this.service = service;
    }

    /** 患者一覧（q で患者ID/名の部分一致検索）。 */
    @GetMapping("/api/patients")
    public List<PatientDto> patients(@RequestParam(required = false) String q) {
        return service.listPatients(q);
    }

    /** 患者情報（患者レベル）の編集。 */
    @PutMapping("/api/patients/{patientId}")
    public Map<String, Object> updatePatient(@PathVariable String patientId, @RequestBody PatientEdit edit) {
        int n = service.updatePatient(patientId, edit.patientName(), edit.patientBirthDate(),
                edit.patientSex(), edit.newPatientId());
        return Map.of("updatedInstances", n);
    }

    /** 患者の削除（全スタディ）。 */
    @DeleteMapping("/api/patients/{patientId}")
    public Map<String, Object> deletePatient(@PathVariable String patientId) {
        return Map.of("deletedInstances", service.deletePatient(patientId));
    }

    /** スタディの削除。 */
    @DeleteMapping("/api/studies/{studyUid}")
    public Map<String, Object> deleteStudy(@PathVariable String studyUid) {
        return Map.of("deletedInstances", service.deleteStudy(studyUid));
    }

    /** シリーズの削除。 */
    @DeleteMapping("/api/series/{studyUid}/{seriesUid}")
    public Map<String, Object> deleteSeries(@PathVariable String studyUid, @PathVariable String seriesUid) {
        return Map.of("deletedInstances", service.deleteSeries(studyUid, seriesUid));
    }

    /** スタディ単位の患者情報編集（そのスタディのみ。PatientID 変更で別患者へ移動）。 */
    @PutMapping("/api/studies/{studyUid}/patient")
    public Map<String, Object> updateStudyPatient(@PathVariable String studyUid, @RequestBody PatientEdit edit) {
        int n = service.updateStudyPatient(studyUid, edit.patientName(), edit.patientBirthDate(),
                edit.patientSex(), edit.newPatientId());
        return Map.of("updatedInstances", n);
    }

    /** シリーズ統合（同一スタディ内 N→1・InstanceNumber 再採番）。 */
    @PostMapping("/api/dbadmin/series/merge")
    public Map<String, Object> mergeSeries(@RequestBody MergeRequest req) {
        if (req == null || req.studyUid() == null || req.studyUid().isBlank()
                || req.sourceSeriesUids() == null || req.sourceSeriesUids().isEmpty()) {
            throw new IllegalArgumentException("studyUid と sourceSeriesUids は必須です");
        }
        MergeTarget tgt = req.target() != null ? req.target() : new MergeTarget(null, null, null);
        DbAdminService.MergeResult r = service.mergeSeries(req.studyUid(), req.sourceSeriesUids(),
                tgt.seriesInstanceUid(), tgt.seriesNumber(), tgt.seriesDescription());
        return Map.of("moved", r.moved(), "failed", r.failed(), "seriesInstanceUid", r.seriesInstanceUid());
    }

    /** シリーズ分割（同一スタディ内 1→N・手動群・InstanceNumber 保持）。 */
    @PostMapping("/api/dbadmin/series/split")
    public Map<String, Object> splitSeries(@RequestBody SplitRequest req) {
        if (req == null || req.studyUid() == null || req.studyUid().isBlank()
                || req.seriesUid() == null || req.seriesUid().isBlank()
                || req.groups() == null || req.groups().isEmpty()) {
            throw new IllegalArgumentException("studyUid / seriesUid / groups は必須です");
        }
        List<DbAdminService.SplitGroup> groups = req.groups().stream()
                .map(g -> new DbAdminService.SplitGroup(g.sopInstanceUids(), g.seriesNumber(), g.seriesDescription()))
                .toList();
        DbAdminService.SplitResult r = service.splitSeries(req.studyUid(), req.seriesUid(), groups);
        return Map.of("groupsCreated", r.groupsCreated(), "moved", r.moved(),
                "failed", r.failed(), "newSeriesUids", r.newSeriesUids());
    }

    /** 統計（時系列スタディ数・モダリティ別 など）。 */
    @GetMapping("/api/stats")
    public StatsDto stats() {
        return service.stats();
    }

    public record PatientEdit(String patientName, String patientBirthDate, String patientSex,
                              String newPatientId) {
    }

    public record MergeRequest(String studyUid, List<String> sourceSeriesUids, MergeTarget target) {
    }

    public record MergeTarget(String seriesInstanceUid, Integer seriesNumber, String seriesDescription) {
    }

    public record SplitRequest(String studyUid, String seriesUid, List<SplitGroupReq> groups) {
    }

    public record SplitGroupReq(List<String> sopInstanceUids, Integer seriesNumber, String seriesDescription) {
    }
}
