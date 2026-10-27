/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 索引に足した StudyTime・StudyID・ReferringPhysicianName: 取り込みで入ること、値が無いファイルは空文字（null は
 * 「まだ読んでいない」印）になること、列を足す前の行を起動時に埋め直せること、読めない行は null のまま残ることを確かめる。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:studyextras;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class StudyExtrasIndexTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository repo;
    @Autowired
    StorageLayout layout;

    private void ingest(String study, String sop, String time, String id, String physician) throws Exception {
        Attributes a = DicomPhantomFactory.scImage("PX", study, study + ".1", sop);
        a.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192");
        if (time != null) {
            a.setString(Tag.StudyTime, VR.TM, time);
        }
        if (id != null) {
            a.setString(Tag.StudyID, VR.SH, id);
        }
        if (physician != null) {
            a.setString(Tag.ReferringPhysicianName, VR.PN, physician);
        }
        Path f = Files.createTempFile("extras", ".dcm");
        storage.ingest(DicomPhantomFactory.writeFile(f, a, UID.ExplicitVRLittleEndian));
    }

    /** 列を足す前に取り込んだ行を再現する（3 列が null）。 */
    private void makeOld(String sop) {
        DicomInstance row = repo.findById(sop).orElseThrow();
        row.setStudyTime(null);
        row.setStudyId(null);
        row.setReferringPhysicianName(null);
        repo.save(row);
    }

    @Test
    void ingest_storesTheThreeValues() throws Exception {
        ingest("1.9.x.a", "1.9.x.a.1", "093015", "S1", "鈴木^一郎");
        DicomInstance r = repo.findById("1.9.x.a.1").orElseThrow();
        assertEquals("093015", r.getStudyTime());
        assertEquals("S1", r.getStudyId());
        assertEquals("鈴木^一郎", r.getReferringPhysicianName());
    }

    @Test
    void ingest_withoutTheAttributes_storesEmptyStringsNotNull() throws Exception {
        ingest("1.9.x.b", "1.9.x.b.1", null, null, null);
        DicomInstance r = repo.findById("1.9.x.b.1").orElseThrow();
        assertEquals("", r.getStudyTime(), "値が無い＝空文字。null だと「まだ読んでいない」と区別できない");
        assertEquals("", r.getStudyId());
        assertEquals("", r.getReferringPhysicianName());
    }

    @Test
    void backfill_fillsRowsFromTheStoredHeader_andDoesNotReadThemAgain() throws Exception {
        ingest("1.9.x.c", "1.9.x.c.1", "101500", "S9", "Smith^John");
        ingest("1.9.x.c", "1.9.x.c.2", null, null, null);
        makeOld("1.9.x.c.1");
        makeOld("1.9.x.c.2");
        assertNull(repo.findById("1.9.x.c.1").orElseThrow().getStudyTime(), "前提: 未読の行がある");

        assertEquals(2, storage.backfillStudyExtras());

        DicomInstance filled = repo.findById("1.9.x.c.1").orElseThrow();
        assertEquals("101500", filled.getStudyTime());
        assertEquals("S9", filled.getStudyId());
        assertEquals("Smith^John", filled.getReferringPhysicianName());
        DicomInstance absent = repo.findById("1.9.x.c.2").orElseThrow();
        assertEquals("", absent.getStudyTime(), "ファイルに値が無い行は、読んだ印として空文字");
        assertEquals("", absent.getStudyId());
        assertEquals(0, storage.backfillStudyExtras(), "読んだ行は再び読まない");
    }

    @Test
    void backfill_leavesAnUnreadableRowNull_insteadOfGuessing() throws Exception {
        ingest("1.9.x.d", "1.9.x.d.1", "120000", "S4", "Brown^Ann");
        makeOld("1.9.x.d.1");
        DicomInstance row = repo.findById("1.9.x.d.1").orElseThrow();
        Files.delete(layout.resolveForRead(row));

        assertEquals(0, storage.backfillStudyExtras(), "ファイルが無い行は埋められない");
        DicomInstance after = repo.findById("1.9.x.d.1").orElseThrow();
        assertNull(after.getStudyTime(), "空文字で埋めない（読めなかった＝未読のまま）");
        assertNull(after.getStudyId());
    }
}
