/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
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

    /** 統計（時系列スタディ数・モダリティ別 など）。 */
    @GetMapping("/api/stats")
    public StatsDto stats() {
        return service.stats();
    }

    public record PatientEdit(String patientName, String patientBirthDate, String patientSex,
                              String newPatientId) {
    }
}
