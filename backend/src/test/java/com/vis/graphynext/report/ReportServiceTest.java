/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Report の CRUD・編集ロック・スタディ件数集計を検証する（`fw/report-design.md` R1）。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:report;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ReportServiceTest {

    @Autowired
    ReportService service;

    @Autowired
    ReportRepository repo;

    @Test
    void createThenGet_roundTripsBodyAndDefaults() {
        CreateReportRequest req = new CreateReportRequest(
                "PID1", "STUDY.1", "胸部CT 読影レポート", ReportType.IMAGING_DIAGNOSTIC,
                "既往歴なし", "紹介医A", "## 所見\n\n異常なし。");
        ReportDto created = service.create(req);

        assertNotNull(created.id());
        assertEquals(ReportStatus.DRAFT, created.status());
        assertEquals(ReportType.IMAGING_DIAGNOSTIC, created.reportType());
        assertTrue(created.participants().isEmpty());
        assertTrue(created.keyImages().isEmpty());

        ReportDto fetched = service.get(created.id());
        assertEquals("## 所見\n\n異常なし。", fetched.bodyMarkdown());
        assertEquals("STUDY.1", fetched.studyInstanceUid());
    }

    @Test
    void update_replacesParticipantsAndKeyImages() {
        ReportDto created = service.create(new CreateReportRequest(
                "PID2", "STUDY.2", "title", null, null, null, null));

        UpdateReportRequest update = new UpdateReportRequest(
                "更新後タイトル", "本文更新", null, null,
                List.of(new UpdateReportRequest.ParticipantInput(
                        "山田太郎", StaffRole.PHYSICIAN, ParticipationType.AUTHOR, "放射線科")),
                List.of(new UpdateReportRequest.KeyImageInput(
                        "SOP.1", "SERIES.1", null, "key1", null, 0)),
                null);
        ReportDto updated = service.update(created.id(), update);

        assertEquals("更新後タイトル", updated.title());
        assertEquals("本文更新", updated.bodyMarkdown());
        assertEquals(1, updated.participants().size());
        assertEquals(StaffRole.PHYSICIAN, updated.participants().get(0).staffRole());
        assertEquals(1, updated.keyImages().size());
        assertEquals("SOP.1", updated.keyImages().get(0).sopInstanceUid());

        // 再度キー画像を空へ更新 → 全置換で消える
        ReportDto cleared = service.update(created.id(), new UpdateReportRequest(
                null, null, null, null, null, List.of(), null));
        assertTrue(cleared.keyImages().isEmpty());
        assertEquals(1, cleared.participants().size(), "participants=null は変更しない");
    }

    @Test
    void finalizedReport_cannotBeUpdatedOrDeleted() {
        ReportDto created = service.create(new CreateReportRequest(
                "PID3", "STUDY.3", "title", null, null, null, null));
        Report entity = repo.findById(created.id()).orElseThrow();
        entity.setStatus(ReportStatus.FINAL);
        repo.save(entity);

        assertThrows(ResponseStatusException.class,
                () -> service.update(created.id(), new UpdateReportRequest(
                        "x", null, null, null, null, null, null)));
        assertThrows(ResponseStatusException.class, () -> service.delete(created.id()));
    }

    @Test
    void lock_blocksOtherEditorUntilUnlocked() {
        ReportDto created = service.create(new CreateReportRequest(
                "PID4", "STUDY.4", "title", null, null, null, null));

        service.lock(created.id(), "userA");
        assertThrows(ResponseStatusException.class, () -> service.lock(created.id(), "userB"));
        // 同一ユーザーの再ロックは許可（idempotent）
        service.lock(created.id(), "userA");

        // 別ユーザーは編集(update)もブロックされる
        assertThrows(ResponseStatusException.class,
                () -> service.update(created.id(), new UpdateReportRequest(
                        "x", null, null, null, null, null, "userB")));

        service.unlock(created.id(), "userA");
        ReportDto afterUnlock = service.update(created.id(), new UpdateReportRequest(
                "userBが編集", null, null, null, null, null, "userB"));
        assertEquals("userBが編集", afterUnlock.title());
    }

    @Test
    void delete_removesDraftReport() {
        ReportDto created = service.create(new CreateReportRequest(
                "PID5", "STUDY.5", "title", null, null, null, null));
        service.delete(created.id());
        assertThrows(ResponseStatusException.class, () -> service.get(created.id()));
    }

    @Test
    void studyCounts_reflectsDraftAndFinalState() {
        ReportDto draft = service.create(new CreateReportRequest(
                "PID6", "STUDY.6", "draft report", null, null, null, null));
        ReportDto toFinalize = service.create(new CreateReportRequest(
                "PID6", "STUDY.7", "final report", null, null, null, null));
        Report entity = repo.findById(toFinalize.id()).orElseThrow();
        entity.setStatus(ReportStatus.FINAL);
        repo.save(entity);

        List<StudyReportCountDto> counts = service.studyCounts(List.of("STUDY.6", "STUDY.7", "STUDY.NONE"));
        assertEquals(3, counts.size());
        assertEquals("draft", findState(counts, "STUDY.6"));
        assertEquals("report", findState(counts, "STUDY.7"));
        assertEquals("none", findState(counts, "STUDY.NONE"));

        assertNotNull(draft);
    }

    private static String findState(List<StudyReportCountDto> counts, String studyUid) {
        return counts.stream().filter(c -> c.studyInstanceUid().equals(studyUid)).findFirst().orElseThrow().reportState();
    }
}
