/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.plugin.store.PluginDocument;
import com.vis.graphynext.plugin.store.PluginDocumentId;
import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.registration.RegistrationDocument;
import com.vis.graphynext.registration.RegistrationDocumentRepository;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.report.ReportStatus;
import com.vis.graphynext.report.ReportType;
import com.vis.graphynext.roi.RoiDocument;
import com.vis.graphynext.roi.RoiDocumentRepository;
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
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 患者 ID を変えたとき、患者キーで引く記録（ROI・位置合わせ・プラグイン）とレポートの患者 ID を運ぶ。
 * 患者全体ならまるごと、検査 1 件ならその検査の分だけ。移し先にすでにあれば上書きしない。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:recmover;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class PatientRecordMoverTest {

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
    RoiDocumentRepository rois;
    @Autowired
    RegistrationDocumentRepository regs;
    @Autowired
    PluginDocumentRepository plugins;
    @Autowired
    ReportRepository reports;

    private final ObjectMapper mapper = new ObjectMapper();

    private void ingest(String pid, String study, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, study + ".se", sop);
        ds.setString(Tag.PatientName, VR.PN, pid + "^N");
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian));
    }

    private static String roi(String uid, String study, String sop) {
        return "{\"roiUid\":\"" + uid + "\",\"tool\":\"Length\",\"sopInstanceUid\":\"" + sop + "\""
                + (study == null ? "" : ",\"studyUid\":\"" + study + "\"") + "}";
    }

    private static String reg(String fixedStudy, String movingStudy) {
        return "{\"version\":1,\"savedAt\":\"" + fixedStudy + movingStudy + "\",\"fixed\":{\"studyInstanceUid\":\"" + fixedStudy
                + "\"},\"moving\":{\"studyInstanceUid\":\"" + movingStudy + "\"}}";
    }

    private List<String> roiUids(String key) throws Exception {
        JsonNode n = mapper.readTree(rois.findById(key).orElseThrow().getJson());
        List<String> out = new ArrayList<>();
        n.path("rois").forEach(r -> out.add(r.path("roiUid").asText()));
        return out;
    }

    private void report(String id, String pid, String study) {
        Report r = new Report(id);
        r.setPatientId(pid);
        r.setStudyInstanceUid(study);
        r.setReportType(ReportType.GENERAL);
        r.setStatus(ReportStatus.DRAFT);
        r.setCreatedAt(Instant.now());
        r.setUpdatedAt(Instant.now());
        reports.save(r);
    }

    @Test
    void 患者全体の_ID_変更は記録をまるごと新しい鍵へ移す() throws Exception {
        ingest("WH1", "wh.a", "wh.a.1");
        ingest("WH1", "wh.b", "wh.b.1");
        rois.save(new RoiDocument("WH1", "{\"schema\":1,\"writer\":\"x\",\"rois\":[" + roi("r1", "wh.a", "wh.a.1") + ","
                + roi("r2", "wh.b", "wh.b.1") + "],\"deleted\":[{\"roiUid\":\"gone\",\"at\":\"t\"}]}", 2));
        regs.save(new RegistrationDocument("WH1", "{\"version\":1,\"records\":[" + reg("wh.a", "wh.b") + "]}", 1));
        plugins.save(new PluginDocument("pa", "WH1", "{\"x\":1}"));
        report("rep-wh", "WH1", "wh.a");

        var r = dbAdmin.updatePatient("WH1", "WH9^N", "", "", "WH9").records();

        assertEquals(List.of("r1", "r2"), roiUids("WH9"));
        assertFalse(rois.existsById("WH1"));
        assertEquals(2, rois.findById("WH9").orElseThrow().getRoiCount());
        assertTrue(rois.findById("WH9").orElseThrow().getJson().contains("\"writer\":\"x\""), "最上位の値を保つ");
        assertTrue(regs.existsById("WH9") && !regs.existsById("WH1"));
        assertTrue(plugins.existsById(new PluginDocumentId("pa", "WH9")));
        assertEquals("WH9", reports.findById("rep-wh").orElseThrow().getPatientId());
        assertEquals(new PatientRecordMover.Result(2, 0, 1, 1, 0, 1, 0), r);
    }

    @Test
    void 検査_1_件の移動はその検査の分だけ移し_プラグインは動かさない() throws Exception {
        ingest("ST1", "st.a", "st.a.1");
        ingest("ST1", "st.b", "st.b.1");
        rois.save(new RoiDocument("ST1", "{\"schema\":1,\"rois\":[" + roi("r1", "st.a", "st.a.1") + ","
                + roi("r2", "st.b", "st.b.1") + "," + roi("r3", null, "st.a.1") + "],"
                + "\"deleted\":[{\"roiUid\":\"gone\",\"at\":\"t\"}],"
                + "\"analyses\":[{\"pickUid\":\"r1\",\"studyUid\":\"st.a\"},{\"pickUid\":\"r2\",\"studyUid\":\"st.b\"}]}", 3));
        regs.save(new RegistrationDocument("ST1", "{\"version\":1,\"records\":[" + reg("st.a", "st.a") + ","
                + reg("st.b", "st.b") + "]}", 2));
        plugins.save(new PluginDocument("pb", "ST1", "{}"));

        var r = dbAdmin.updateStudyPatient("st.a", "ST8^N", "", "", "ST8").records();

        assertEquals(List.of("r1", "r3"), roiUids("ST8"), "studyUid の無い ROI は SOP で判定");
        assertEquals(List.of("r2"), roiUids("ST1"));
        assertEquals(1, rois.findById("ST1").orElseThrow().getRoiCount());
        JsonNode moved = mapper.readTree(rois.findById("ST8").orElseThrow().getJson());
        assertEquals("r1", moved.path("analyses").get(0).path("pickUid").asText());
        assertEquals(1, moved.path("analyses").size());
        assertEquals("gone", moved.path("deleted").get(0).path("roiUid").asText(), "墓標は写す");
        assertEquals(1, regs.findById("ST8").orElseThrow().getRecordCount());
        assertEquals(1, regs.findById("ST1").orElseThrow().getRecordCount());
        assertTrue(plugins.existsById(new PluginDocumentId("pb", "ST1")), "プラグインの記録は分けられないので残す");
        assertEquals(new PatientRecordMover.Result(2, 0, 1, 0, 1, 0, 0), r);
    }

    @Test
    void すでに記録のある患者へ統合しても上書きしない() throws Exception {
        ingest("MG1", "mg.a", "mg.a.1");
        ingest("MG2", "mg.b", "mg.b.1");
        rois.save(new RoiDocument("MG1", "{\"schema\":1,\"rois\":[" + roi("dup", "mg.a", "mg.a.1") + ","
                + roi("only1", "mg.a", "mg.a.1") + "]}", 2));
        rois.save(new RoiDocument("MG2", "{\"schema\":1,\"writer\":\"keep\",\"rois\":[" + roi("dup", "mg.b", "mg.b.1") + "]}", 1));
        plugins.save(new PluginDocument("pc", "MG1", "{\"from\":1}"));
        plugins.save(new PluginDocument("pc", "MG2", "{\"from\":2}"));

        var r = dbAdmin.updatePatient("MG1", "MG2^N", "", "", "MG2").records();

        assertEquals(List.of("dup", "only1"), roiUids("MG2"));
        String dupStudy = mapper.readTree(rois.findById("MG2").orElseThrow().getJson()).path("rois").get(0)
                .path("studyUid").asText();
        assertEquals("mg.b", dupStudy, "重なった roiUid は移し先を残す");
        assertEquals(2, rois.findById("MG2").orElseThrow().getRoiCount());
        assertTrue(rois.findById("MG2").orElseThrow().getJson().contains("\"writer\":\"keep\""));
        assertEquals("{\"from\":2}", plugins.findById(new PluginDocumentId("pc", "MG2")).orElseThrow().getJson());
        assertTrue(plugins.existsById(new PluginDocumentId("pc", "MG1")), "移せなかったものは元の鍵に残す");
        assertEquals(new PatientRecordMover.Result(1, 1, 0, 0, 1, 0, 0), r);
    }
}
