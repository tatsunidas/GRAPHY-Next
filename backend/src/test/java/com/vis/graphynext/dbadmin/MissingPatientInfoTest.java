/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.StudyDto;
import com.vis.graphynext.dicom.StudySearch;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 患者 ID・氏名が空（匿名化などで消えた）の検査を、DB 管理で見つけて割り当てられること。
 * 部分一致の検索は空に何も一致せず、患者 ID が空だとパスの宛先（/api/patients/{id}）も成り立たなかった。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=standalone",
        "spring.datasource.url=jdbc:h2:mem:missingpatient;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false"
})
@AutoConfigureMockMvc
class MissingPatientInfoTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("dicom").toString());
        r.add("graphy.plugins.dir", () -> tmp.resolve("plugins").toString());
    }

    @Autowired
    MockMvc mvc;
    @Autowired
    DbAdminService dbAdmin;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository repo;

    /** ID 空の患者は全テストで共有になるので、前のテストの行を残さない（割り当て・削除は ID 空の全行に効く）。 */
    @org.junit.jupiter.api.BeforeEach
    void clearEmptyIdRows() {
        repo.deleteAll(repo.findByPatientId(""));
    }

    /** name が null なら氏名タグを持たせない（匿名化で消えた状態）。 */
    private void ingest(String pid, String name, String study, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, study + ".se", sop);
        if (name == null) {
            ds.remove(Tag.PatientName);
        } else {
            ds.setString(Tag.PatientName, VR.PN, name);
        }
        ds.setString(Tag.Modality, VR.CS, "XA");
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);
    }

    private boolean hasStudy(java.util.List<StudyDto> l, String uid) {
        return l.stream().anyMatch(s -> uid.equals(s.studyInstanceUid()));
    }

    @Test
    void onlyMissing_findsEmptyIdAndEmptyName_butNotCompletePatients() throws Exception {
        ingest("", null, "MP1.empty", "MP1.sop1");            // 患者 ID も氏名も空
        ingest("MP1-NONAME", null, "MP1.noname", "MP1.sop2"); // 氏名だけ空
        ingest("MP1-OK", "Complete^Person", "MP1.ok", "MP1.sop3");

        var missing = storage.listStudies(new StudySearch(null, null, null, null, null, null, true));
        assertTrue(hasStudy(missing, "MP1.empty"), "ID も氏名も空の検査が出る");
        assertTrue(hasStudy(missing, "MP1.noname"), "氏名だけ空の検査も出る");
        assertFalse(hasStudy(missing, "MP1.ok"), "負例: 揃っている患者は出ない");

        // 従来の検索は変わらない（空には当たらず、揃った患者は部分一致で出る）
        var partial = storage.listStudies(new StudySearch("MP1-OK", null, null, null, null, null));
        assertTrue(hasStudy(partial, "MP1.ok"));
        assertFalse(hasStudy(storage.listStudies(new StudySearch("x", null, null, null, null, null)), "MP1.empty"),
                "部分一致では空の検査に当たらない（これが元の落とし穴）");

        var ids = dbAdmin.listPatients(null, true).stream().map(p -> p.patientId()).toList();
        assertTrue(ids.contains(""), "患者一覧の「未設定のみ」に ID 空の患者が出る");
        assertTrue(ids.contains("MP1-NONAME"));
        assertFalse(ids.contains("MP1-OK"));
    }

    @Test
    void studiesEndpoint_missingPatientInfo_overHttp() throws Exception {
        ingest("", null, "MP2.empty", "MP2.sop1");
        ingest("MP2-OK", "Complete^Person", "MP2.ok", "MP2.sop2");

        String body = mvc.perform(get("/api/studies").param("missingPatientInfo", "true"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertTrue(body.contains("MP2.empty"));
        assertFalse(body.contains("MP2.ok"), "負例: 揃った患者は出ない");
    }

    @Test
    void assignToEmptyIdPatient_byQuery_leavesOthersUntouched() throws Exception {
        ingest("", null, "MP3.empty", "MP3.sop1");
        ingest("MP3-OK", "Complete^Person", "MP3.ok", "MP3.sop2");

        // パスだと宛先が成り立たない患者 ID 空を、クエリで指して PID と氏名を割り当てる
        mvc.perform(put("/api/patients").param("patientId", "")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"patientName\":\"Assigned^Name\",\"newPatientId\":\"MP3-NEW\"}"))
                .andExpect(status().isOk());

        var moved = repo.findByPatientId("MP3-NEW");
        assertTrue(moved.stream().anyMatch(r -> "MP3.empty".equals(r.getStudyInstanceUid())), "割り当てた ID に移る");
        assertTrue(moved.stream().allMatch(r -> "Assigned^Name".equals(r.getPatientName())));
        var ok = repo.findByPatientId("MP3-OK");
        assertEquals(1, ok.size(), "他の患者は変わらない");
        assertEquals("Complete^Person", ok.get(0).getPatientName());
        assertFalse(dbAdmin.listPatients(null, true).stream().anyMatch(p -> "MP3-NEW".equals(p.patientId())),
                "割り当て後は「未設定のみ」から消える");
    }

    @Test
    void deleteEmptyIdPatient_byQuery_deletesOnlyThat() throws Exception {
        ingest("", null, "MP4.empty", "MP4.sop1");
        ingest("MP4-OK", "Complete^Person", "MP4.ok", "MP4.sop2");

        mvc.perform(delete("/api/patients").param("patientId", "")).andExpect(status().isOk());

        assertEquals(0, repo.findByPatientId("").size(), "ID 空の行は消える");
        assertEquals(1, repo.findByPatientId("MP4-OK").size(), "負例: 他の患者は消えない");
    }
}
