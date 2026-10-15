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
@org.springframework.test.context.event.RecordApplicationEvents
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
    private com.vis.graphynext.dicom.store.StorageLayout layout;

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
        Path f = layout.resolveForRead(rows.get(0));
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            Attributes ds = in.readDataset();
            assertEquals("New^Name", ds.getString(Tag.PatientName), "DICOM ファイルのタグも書換");
            assertEquals("19800101", ds.getString(Tag.PatientBirthDate));
        }
    }

    /** モード A（Drive 正本）の「手元に無い」を再現する取り寄せ口。ensureLocal は保存しておいた内容を書き戻す／失敗させる。 */
    private static final class EvictedBackend implements com.vis.graphynext.dicom.store.StorageBackend {
        final java.util.Map<String, byte[]> remote = new java.util.HashMap<>();
        final java.util.List<String> fetched = new java.util.ArrayList<>();
        final Path root;
        boolean fail;

        EvictedBackend(Path root) {
            this.root = root;
        }

        @Override public boolean cacheMode() {
            return true;
        }

        @Override public Path ensureLocal(String rel) {
            byte[] b = remote.get(rel);
            if (b == null) {
                return null;
            }
            if (fail) {
                throw new com.vis.graphynext.dicom.store.StorageUnavailableException("offline");
            }
            try {
                Path p = root.resolve(rel);
                Files.createDirectories(p.getParent());
                Files.write(p, b);
                fetched.add(rel);
                return p;
            } catch (java.io.IOException e) {
                throw new java.io.UncheckedIOException(e);
            }
        }

        @Override public void prefetch(java.util.Collection<String> rels, java.util.function.BooleanSupplier cancelled) {
            rels.forEach(this::ensureLocal);
        }

        @Override public void touch(String rel) {
        }
    }

    @Autowired
    org.springframework.test.context.event.ApplicationEvents events;

    /** 取り込んだファイルを「追い出した」状態にする（手元から消し、正本は backend が持つ）。 */
    private EvictedBackend evict(String pid) throws Exception {
        DicomInstance r = repo.findByPatientId(pid).get(0);
        Path f = layout.resolveForRead(r);
        EvictedBackend be = new EvictedBackend(layout.root());
        be.remote.put(layout.toStored(f), Files.readAllBytes(f));
        Files.delete(f);
        return be;
    }

    @Test
    void モードA_追い出し済みの患者を編集すると_先に取り寄せて書き換え_変更を通知する() throws Exception {
        ingest("EDITA", "Old^Name", "EDITA.s", "se", "EDITA.sop", "CT");
        EvictedBackend be = evict("EDITA");
        layout.setBackend(be);
        try {
            events.clear();
            dbAdmin.updatePatient("EDITA", "New^Name", "19800101", "M", null);
            assertEquals(1, be.fetched.size(), "書き換える前に取り寄せた");
            Path f = layout.root().resolve(be.fetched.get(0));
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                in.readFileMetaInformation();
                assertEquals("New^Name", in.readDataset().getString(Tag.PatientName), "取り寄せたファイルが書き換わった");
            }
            assertTrue(events.stream(com.vis.graphynext.gdrive.StorageChanged.class)
                    .anyMatch(e -> e.relPath().equals(be.fetched.get(0))), "書き換えを Drive 同期へ通知した（再アップロードされる）");
            assertEquals("New^Name", repo.findByPatientId("EDITA").get(0).getPatientName());
        } finally {
            layout.setBackend(null);
        }
    }

    @Test
    void モードA_取り寄せに失敗したら_患者編集は索引も変えずに失敗する() throws Exception {
        ingest("EDITB", "Old^Name", "EDITB.s", "se", "EDITB.sop", "CT");
        EvictedBackend be = evict("EDITB");
        be.fail = true;
        layout.setBackend(be);
        try {
            org.junit.jupiter.api.Assertions.assertThrows(com.vis.graphynext.dicom.store.StorageUnavailableException.class,
                    () -> dbAdmin.updatePatient("EDITB", "New^Name", "19800101", "M", null));
        } finally {
            layout.setBackend(null);
        }
        assertEquals("Old^Name", repo.findByPatientId("EDITB").get(0).getPatientName(),
                "握りつぶして索引だけ更新すると、索引と実体（Drive の正本）が食い違う");
    }

    @Test
    void モードA_追い出し済みの画像を含むシリーズ統合は_取り寄せて移し_元の場所を通知する() throws Exception {
        ingestInst("MGA", "P", "MGA.study", "MGA.se1", "MGA.s1", "CT", 1, 1);
        ingestInst("MGA", "P", "MGA.study", "MGA.se2", "MGA.s2", "CT", 2, 1);
        DicomInstance first = repo.findBySeries("MGA.study", "MGA.se1").get(0);
        String oldRel = layout.toStored(layout.resolveForRead(first));
        Path f = layout.resolveForRead(first);
        EvictedBackend be = new EvictedBackend(layout.root());
        be.remote.put(oldRel, Files.readAllBytes(f));
        Files.delete(f);
        layout.setBackend(be);
        try {
            events.clear();
            DbAdminService.MergeResult r = dbAdmin.mergeSeries("MGA.study", List.of("MGA.se1", "MGA.se2"), null, 7, "M");
            assertEquals(2, r.moved());
            assertEquals(0, r.failed(), "手元に無い画像も取り寄せて移せる");
            assertEquals(List.of(oldRel), be.fetched);
            assertTrue(events.stream(com.vis.graphynext.gdrive.StorageChanged.class).anyMatch(e -> e.relPath().equals(oldRel)),
                    "元の場所が消えたことを Drive 同期へ通知した");
            for (DicomInstance m : repo.findBySeries("MGA.study", r.seriesInstanceUid())) {
                assertTrue(Files.exists(layout.resolveForRead(m)));
            }
        } finally {
            layout.setBackend(null);
        }
    }

    @Test
    void deletePatient_removesRowsAndFiles() throws Exception {
        ingest("DEL1", "Del", "DEL1.s", "se", "DEL1.sop", "CT");
        List<DicomInstance> rows = repo.findByPatientId("DEL1");
        Path f = layout.resolveForRead(rows.get(0));
        assertTrue(Files.exists(f));

        int n = dbAdmin.deletePatient("DEL1").deletedInstances();
        assertEquals(1, n);
        assertTrue(repo.findByPatientId("DEL1").isEmpty(), "索引行が消える");
        assertFalse(Files.exists(f), "実ファイルも消える（既定）");
    }

    @Test
    void deleteSeries_removesOnlyThatSeries() throws Exception {
        ingest("DS1", "P", "DS1.study", "DS1.se1", "DS1.sop1", "CT");
        ingest("DS1", "P", "DS1.study", "DS1.se2", "DS1.sop2", "CT");
        Path f1 = layout.resolveForRead(repo.findBySeries("DS1.study", "DS1.se1").get(0));

        int n = dbAdmin.deleteSeries("DS1.study", "DS1.se1").deletedInstances();

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

        int n = dbAdmin.updateStudyPatient("SP1.studyA", "New^Name", "19900202", "F", "SP2").updatedInstances();

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
        Path f = layout.resolveForRead(sp2.get(0));
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
            Path f = layout.resolveForRead(m);
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
            Path f = layout.resolveForRead(m);
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
