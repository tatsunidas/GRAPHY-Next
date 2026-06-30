/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * standalone のローカル DB 管理（患者一覧/検索・編集[ファイル書換]・削除[ファイル含む]・統計）。
 * 設定未保存なので既定（ファイルも削除/書換）で動作する。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:dbadmin;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DbAdminTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DbAdminService dbAdmin;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository repo;

    private void ingest(String pid, String name, String study, String series, String sop, String modality)
            throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        ds.setString(Tag.PatientName, VR.PN, name);
        ds.setString(Tag.Modality, VR.CS, modality);
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);
    }

    /** SeriesNumber / InstanceNumber も指定する ingest（統合の再採番検証用）。 */
    private void ingestInst(String pid, String name, String study, String series, String sop, String modality,
                            int seriesNo, int instanceNo) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        ds.setString(Tag.PatientName, VR.PN, name);
        ds.setString(Tag.Modality, VR.CS, modality);
        ds.setInt(Tag.SeriesNumber, VR.IS, seriesNo);
        ds.setInt(Tag.InstanceNumber, VR.IS, instanceNo);
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);
    }

    @Test
    void listPatients_withSearch() throws Exception {
        ingest("LST1", "Alice", "LST1.s1", "se", "LST1.sop1", "CT");
        ingest("LST1", "Alice", "LST1.s2", "se", "LST1.sop2", "MR");
        ingest("LST2", "Bob", "LST2.s1", "se", "LST2.sop1", "CT");

        var p1 = dbAdmin.listPatients("LST1");
        assertEquals(1, p1.size());
        assertEquals(2, p1.get(0).numberOfStudies(), "LST1 は 2 スタディ");
        assertEquals(2, p1.get(0).numberOfInstances());
        assertTrue(dbAdmin.listPatients("LST2").stream().anyMatch(p -> "LST2".equals(p.patientId())));
    }

    @Test
    void stats_aggregatesByModality() throws Exception {
        ingest("STAT1", "S", "STAT1.s1", "se", "STAT1.sop1", "CT");
        ingest("STAT1", "S", "STAT1.s2", "se", "STAT1.sop2", "US");

        StatsDto s = dbAdmin.stats();
        assertTrue(s.instanceCountByModality().stream().anyMatch(b -> "CT".equals(b.key())));
        assertTrue(s.instanceCountByModality().stream().anyMatch(b -> "US".equals(b.key())));
        assertTrue(s.volumeBytesByModality().stream().anyMatch(b -> b.value() > 0), "容量は正の値");
        assertTrue(s.studyCountByMonth().stream().anyMatch(b -> b.key().startsWith("2026-")), "時系列は YYYY-MM");
    }

    @Test
    void updatePatient_rewritesFileAndIndex() throws Exception {
        ingest("EDIT1", "Old^Name", "EDIT1.s", "se", "EDIT1.sop", "CT");

        dbAdmin.updatePatient("EDIT1", "New^Name", "19800101", "M", null);

        List<DicomInstance> rows = repo.findByPatientId("EDIT1");
        assertEquals("New^Name", rows.get(0).getPatientName(), "索引が更新される");
        assertEquals("19800101", rows.get(0).getPatientBirthDate());

        // 実ファイルのタグも書き換わっている
        Path f = Path.of(URI.create(rows.get(0).getUri()));
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            Attributes ds = in.readDataset();
            assertEquals("New^Name", ds.getString(Tag.PatientName), "DICOM ファイルのタグも書換");
            assertEquals("19800101", ds.getString(Tag.PatientBirthDate));
        }
    }

    @Test
    void deletePatient_removesRowsAndFiles() throws Exception {
        ingest("DEL1", "Del", "DEL1.s", "se", "DEL1.sop", "CT");
        List<DicomInstance> rows = repo.findByPatientId("DEL1");
        Path f = Path.of(URI.create(rows.get(0).getUri()));
        assertTrue(Files.exists(f));

        int n = dbAdmin.deletePatient("DEL1");
        assertEquals(1, n);
        assertTrue(repo.findByPatientId("DEL1").isEmpty(), "索引行が消える");
        assertFalse(Files.exists(f), "実ファイルも消える（既定）");
    }

    @Test
    void deleteSeries_removesOnlyThatSeries() throws Exception {
        ingest("DS1", "P", "DS1.study", "DS1.se1", "DS1.sop1", "CT");
        ingest("DS1", "P", "DS1.study", "DS1.se2", "DS1.sop2", "CT");
        Path f1 = Path.of(URI.create(repo.findBySeries("DS1.study", "DS1.se1").get(0).getUri()));

        int n = dbAdmin.deleteSeries("DS1.study", "DS1.se1");

        assertEquals(1, n);
        assertTrue(repo.findBySeries("DS1.study", "DS1.se1").isEmpty(), "対象シリーズは消える");
        assertEquals(1, repo.findBySeries("DS1.study", "DS1.se2").size(), "別シリーズは残る");
        assertFalse(Files.exists(f1), "対象シリーズの実ファイルは消える");
    }

    @Test
    void updateStudyPatient_movesOnlyThatStudyAndDropsEmptyPatient() throws Exception {
        // 患者 SP1 が 2 スタディ。片方だけ別患者 SP2 へ移す。
        ingest("SP1", "Old^Name", "SP1.studyA", "se", "SP1.sopA", "CT");
        ingest("SP1", "Old^Name", "SP1.studyB", "se", "SP1.sopB", "MR");

        int n = dbAdmin.updateStudyPatient("SP1.studyA", "New^Name", "19900202", "F", "SP2");

        assertEquals(1, n, "studyA の 1 件のみ更新");
        // studyA は SP2 へ移動
        List<DicomInstance> sp2 = repo.findByPatientId("SP2");
        assertEquals(1, sp2.size());
        assertEquals("SP1.studyA", sp2.get(0).getStudyInstanceUid());
        assertEquals("New^Name", sp2.get(0).getPatientName());
        // 編集元 SP1 は studyB だけ残る
        List<DicomInstance> sp1 = repo.findByPatientId("SP1");
        assertEquals(1, sp1.size());
        assertEquals("SP1.studyB", sp1.get(0).getStudyInstanceUid());
        // ファイルのタグも SP2 へ
        Path f = Path.of(URI.create(sp2.get(0).getUri()));
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            Attributes ds = in.readDataset();
            assertEquals("SP2", ds.getString(Tag.PatientID));
            assertEquals("New^Name", ds.getString(Tag.PatientName));
        }
    }

    @Test
    void mergeSeries_combinesIntoOneAndRenumbers() throws Exception {
        // 同一スタディ・2 シリーズ（se1: 2枚 #1,#2 / se2: 1枚 #1）を統合 → 3枚を 1..3 に振り直す。
        ingestInst("MG1", "P", "MG1.study", "MG1.se1", "MG1.s1", "CT", 1, 1);
        ingestInst("MG1", "P", "MG1.study", "MG1.se1", "MG1.s2", "CT", 1, 2);
        ingestInst("MG1", "P", "MG1.study", "MG1.se2", "MG1.s3", "CT", 2, 1);

        DbAdminService.MergeResult r = dbAdmin.mergeSeries(
                "MG1.study", List.of("MG1.se1", "MG1.se2"), null, 99, "Merged");

        assertEquals(3, r.moved());
        assertEquals(0, r.failed());
        // 旧シリーズは消え、統合先に 3 枚
        assertTrue(repo.findBySeries("MG1.study", "MG1.se1").isEmpty());
        assertTrue(repo.findBySeries("MG1.study", "MG1.se2").isEmpty());
        List<DicomInstance> merged = repo.findBySeries("MG1.study", r.seriesInstanceUid());
        assertEquals(3, merged.size());
        // InstanceNumber は 1..3、SeriesNumber=99、ファイルも移動・タグ整合
        List<Integer> nums = merged.stream().map(DicomInstance::getInstanceNumber).sorted().toList();
        assertEquals(List.of(1, 2, 3), nums);
        for (DicomInstance m : merged) {
            assertEquals(99, m.getSeriesNumber());
            Path f = Path.of(URI.create(m.getUri()));
            assertTrue(Files.exists(f), "新パスにファイルがある");
            assertTrue(f.toString().contains(r.seriesInstanceUid()), "パスが統合先シリーズ配下");
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                in.readFileMetaInformation();
                Attributes ds = in.readDataset();
                assertEquals(r.seriesInstanceUid(), ds.getString(Tag.SeriesInstanceUID), "ファイルの SeriesUID も更新");
            }
        }
    }

    @Test
    void splitSeries_movesGroupsAndKeepsInstanceNumbers() throws Exception {
        // 1 シリーズ 3 枚（#1,#2,#3）を 1 群（#1,#2）だけ分割。残り(#3)は元シリーズに残る。
        ingestInst("SPL1", "P", "SPL1.study", "SPL1.se", "SPL1.s1", "CT", 1, 1);
        ingestInst("SPL1", "P", "SPL1.study", "SPL1.se", "SPL1.s2", "CT", 1, 2);
        ingestInst("SPL1", "P", "SPL1.study", "SPL1.se", "SPL1.s3", "CT", 1, 3);

        DbAdminService.SplitResult r = dbAdmin.splitSeries(
                "SPL1.study", "SPL1.se",
                List.of(new DbAdminService.SplitGroup(List.of("SPL1.s1", "SPL1.s2"), null, "Part A")));

        assertEquals(1, r.groupsCreated());
        assertEquals(2, r.moved());
        assertEquals(0, r.failed());
        // 元シリーズには #3 のみ残る
        List<DicomInstance> remain = repo.findBySeries("SPL1.study", "SPL1.se");
        assertEquals(1, remain.size());
        assertEquals("SPL1.s3", remain.get(0).getSopInstanceUid());
        // 新シリーズに #1,#2（InstanceNumber は保持）
        List<DicomInstance> newSer = repo.findBySeries("SPL1.study", r.newSeriesUids().get(0));
        assertEquals(2, newSer.size());
        List<Integer> nums = newSer.stream().map(DicomInstance::getInstanceNumber).sorted().toList();
        assertEquals(List.of(1, 2), nums, "InstanceNumber は保持される");
        for (DicomInstance m : newSer) {
            assertEquals("Part A", m.getSeriesDescription());
            Path f = Path.of(URI.create(m.getUri()));
            assertTrue(Files.exists(f) && f.toString().contains(r.newSeriesUids().get(0)));
        }
    }

    @Test
    void updateStudyPatient_onlyStudyDeletesSourcePatientFromList() throws Exception {
        // 患者 SO1 が 1 スタディのみ。別患者へ移すと SO1 は一覧から消える。
        ingest("SO1", "Name", "SO1.study", "se", "SO1.sop", "CT");

        dbAdmin.updateStudyPatient("SO1.study", "Name", "", "", "SO2");

        assertTrue(repo.findByPatientId("SO1").isEmpty(), "編集元患者は 0 件で消える");
        assertEquals(1, repo.findByPatientId("SO2").size());
    }
}
