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
}
