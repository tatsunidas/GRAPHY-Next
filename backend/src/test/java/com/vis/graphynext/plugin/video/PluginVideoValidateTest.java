/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.video;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.plugin.video.PluginVideoImportService.NewPatient;
import com.vis.graphynext.plugin.video.PluginVideoImportService.PatientSpec;
import com.vis.graphynext.plugin.video.PluginVideoImportService.ValidateItem;
import com.vis.graphynext.plugin.video.PluginVideoImportService.ValidateRequest;
import com.vis.graphynext.plugin.video.PluginVideoImportService.ValidateResult;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * H48 の事前確認（{@code POST /api/plugins/{id}/video/validate}）。取り込みジョブ（採点・変換の後）で
 * 初めて「患者 ID は既にあります」と分かるのを防ぐ。副作用が無いことも見る。
 */
class PluginVideoValidateTest {

    /** 保管庫には患者 K12 だけがいる。 */
    private static List<DicomInstance> byPatient(String id) {
        if (!"K12".equals(id)) return List.of();
        DicomInstance k12 = new DicomInstance("1.2.3");
        k12.setPatientId("K12");
        k12.setPatientName("KOSEI^TWELVE");
        return List.of(k12);
    }

    private static ValidateResult validate(ValidateRequest req) {
        return PluginVideoImportService.validate(req, PluginVideoValidateTest::byPatient);
    }

    private static ValidateItem create(String path, String id, String name, String birth, String sex) {
        return new ValidateItem(path, new PatientSpec(null, new NewPatient(id, name, birth, sex)));
    }

    private static ValidateItem existing(String path, String key) {
        return new ValidateItem(path, new PatientSpec(key, null));
    }

    @Test
    void 新しい患者の_ID_が既にあれば_取り込む前に_patient_exists_と既存の患者を返す() {
        ValidateResult r = validate(new ValidateRequest(List.of(create("a.avi", " K12 ", "X", "", ""))));
        assertThat(r.ok()).isFalse();
        assertThat(r.issues()).singleElement().satisfies(i -> {
            assertThat(i.code()).isEqualTo("patient-exists");
            assertThat(i.index()).isZero();
            assertThat(i.path()).isEqualTo("a.avi");
            assertThat(i.existingPatientKey()).isEqualTo("K12");
            assertThat(i.existingPatientName()).isEqualTo("KOSEI^TWELVE");
        });
    }

    @Test
    void 動画ごとに違う患者でも_問題の行だけを返す() {
        ValidateResult r = validate(new ValidateRequest(List.of(
                existing("a.avi", "K12"),
                create("b.avi", "NEW-1", "A^B", "20200101", "f"),
                existing("c.avi", "NOBODY"),
                create("d.avi", "NEW-2", "", "2020-01-01", ""),
                create("e.avi", "NEW-3", "", "", "X"),
                create("f.avi", "", "", "", ""))));
        assertThat(r.issues()).extracting(PluginVideoImportService.ValidateIssue::index,
                        PluginVideoImportService.ValidateIssue::code)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple(2, "patient-not-found"),
                        org.assertj.core.groups.Tuple.tuple(3, "patient-invalid"),
                        org.assertj.core.groups.Tuple.tuple(4, "patient-invalid"),
                        org.assertj.core.groups.Tuple.tuple(5, "patient-invalid"));
    }

    @Test
    void 同じ新しい患者を複数の動画に付けるのはよいが_属性が食い違えば_patient_conflict() {
        assertThat(validate(new ValidateRequest(List.of(
                create("a.avi", "NEW-1", "A^B", "", "F"),
                create("b.avi", "NEW-1", "A^B", "", "f")))).ok()).isTrue();
        ValidateResult r = validate(new ValidateRequest(List.of(
                create("a.avi", "NEW-1", "A^B", "", "F"),
                create("b.avi", "NEW-1", "C^D", "", "F"))));
        assertThat(r.issues()).singleElement().satisfies(i -> {
            assertThat(i.code()).isEqualTo("patient-conflict");
            assertThat(i.index()).isEqualTo(1);
        });
    }

    @Test
    void 患者の指定が無い行と空の要求() {
        assertThat(validate(new ValidateRequest(List.of(new ValidateItem("a.avi", null)))).issues())
                .singleElement().extracting(PluginVideoImportService.ValidateIssue::code).isEqualTo("patient-missing");
        assertThat(validate(new ValidateRequest(null)).ok()).isTrue();
        assertThat(validate(null).ok()).isTrue();
    }
}
