/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dbtransfer.RelatedData;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.plugin.store.PluginDocument;
import com.vis.graphynext.plugin.store.PluginDocumentId;
import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.radiomics.GlamAnalysisDocument;
import com.vis.graphynext.radiomics.GlamAnalysisDocumentRepository;
import com.vis.graphynext.registration.RegistrationDocument;
import com.vis.graphynext.registration.RegistrationDocumentRepository;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.report.ReportStatus;
import com.vis.graphynext.report.ReportType;
import com.vis.graphynext.roi.RoiDocument;
import com.vis.graphynext.roi.RoiDocumentRepository;
import com.vis.graphynext.settings.SettingsService;
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
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 画像を削除したとき、消えた画像に結び付いていた付随データ（ROI・位置合わせ・XA 校正・GLAM・プラグインの記録）を
 * 片付ける。レポートは消さない（画像とは別に管理する）。ファイルを残す設定のときは付随データも残す。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:delrelated;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DeleteRelatedDataTest {

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
    @Autowired
    GlamAnalysisDocumentRepository glam;
    @Autowired
    SettingsService settings;

    private final ObjectMapper mapper = new ObjectMapper();

    private void ingest(String pid, String study, String series, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        ds.setString(Tag.PatientName, VR.PN, pid + "^N");
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian));
    }

    private static String roi(String uid, String sop) {
        return "{\"roiUid\":\"" + uid + "\",\"tool\":\"Length\",\"sopInstanceUid\":\"" + sop + "\"}";
    }

    private static String reg(String fixedSeries, String movingSeries) {
        return "{\"fixed\":{\"seriesInstanceUid\":\"" + fixedSeries + "\"},\"moving\":{\"seriesInstanceUid\":\""
                + movingSeries + "\"}}";
    }

    private List<String> roiUids(String key) throws Exception {
        List<String> out = new ArrayList<>();
        mapper.readTree(rois.findById(key).orElseThrow().getJson()).path("rois")
                .forEach(r -> out.add(r.path("roiUid").asText()));
        return out;
    }

    private void report(String id, String pid, String study, ReportStatus status) {
        Report r = new Report(id);
        r.setPatientId(pid);
        r.setStudyInstanceUid(study);
        r.setReportType(ReportType.GENERAL);
        r.setStatus(status);
        r.setCreatedAt(Instant.now());
        r.setUpdatedAt(Instant.now());
        reports.save(r);
    }

    @Test
    void 検査を消すと_その検査の付随データだけを片付け_レポートは残す() throws Exception {
        ingest("CL1", "cl.a", "cl.a.s", "cl.a.1");
        ingest("CL1", "cl.b", "cl.b.s", "cl.b.1");
        rois.save(new RoiDocument("CL1", "{\"schema\":1,\"rois\":[" + roi("r1", "cl.a.1") + "," + roi("r2", "cl.b.1")
                + "],\"analyses\":[{\"pickUid\":\"r1\",\"sopInstanceUid\":\"cl.a.1\"}]}", 2));
        regs.save(new RegistrationDocument("CL1", "{\"version\":1,\"records\":[" + reg("cl.a.s", "cl.b.s") + ","
                + reg("cl.b.s", "cl.b.s") + "]}", 2));
        settings.putAll(Map.of(RelatedData.calibrationKey("cl.a.s"), "0.3", RelatedData.calibrationKey("cl.b.s"), "0.4"));
        glam.save(new GlamAnalysisDocument("g-a", "cl.a", "cl.a.s", null, "A", "{}", 8, 1, 1));
        glam.save(new GlamAnalysisDocument("g-b", "cl.b", "cl.b.s", null, "B", "{}", 8, 1, 1));
        plugins.save(new PluginDocument("pp", "CL1", "{}"));
        report("rep-a-final", "CL1", "cl.a", ReportStatus.FINAL);
        report("rep-a-draft", "CL1", "cl.a", ReportStatus.DRAFT);

        var r = dbAdmin.deleteStudy("cl.a");

        assertEquals(List.of("r2"), roiUids("CL1"));
        assertEquals(1, rois.findById("CL1").orElseThrow().getRoiCount());
        assertEquals(0, mapper.readTree(rois.findById("CL1").orElseThrow().getJson()).path("analyses").size());
        assertEquals(1, regs.findById("CL1").orElseThrow().getRecordCount(), "消えたシリーズを指す記録だけ消す");
        assertNull(settings.getAll().get(RelatedData.calibrationKey("cl.a.s")));
        assertEquals("0.4", settings.getAll().get(RelatedData.calibrationKey("cl.b.s")));
        assertFalse(glam.existsById("g-a"));
        assertTrue(glam.existsById("g-b"));
        assertTrue(plugins.existsById(new PluginDocumentId("pp", "CL1")), "患者の画像が残るのでプラグインの記録は残す");
        assertTrue(reports.existsById("rep-a-final") && reports.existsById("rep-a-draft"), "レポートは消さない");
        assertEquals(new PatientRecordMover.Cleanup(1, 1, 1, 1, 1, 0), r.related());
    }

    @Test
    void 画像を_1_枚消すと_その画像の_ROI_だけを片付ける() throws Exception {
        ingest("IN1", "in.a", "in.a.s", "in.a.1");
        ingest("IN1", "in.a", "in.a.s", "in.a.2");
        rois.save(new RoiDocument("IN1", "{\"rois\":[" + roi("r1", "in.a.1") + "," + roi("r2", "in.a.2") + "]}", 2));
        settings.putAll(Map.of(RelatedData.calibrationKey("in.a.s"), "0.5"));

        dbAdmin.deleteInstance("in.a", "in.a.s", "in.a.1");

        assertEquals(List.of("r2"), roiUids("IN1"));
        assertEquals("0.5", settings.getAll().get(RelatedData.calibrationKey("in.a.s")), "シリーズは残るので校正も残す");
    }

    @Test
    void 患者の画像がすべて消えたら_患者単位の記録もまるごと消す() throws Exception {
        ingest("PG1", "pg.a", "pg.a.s", "pg.a.1");
        rois.save(new RoiDocument("PG1", "{\"rois\":[" + roi("r1", "pg.a.1") + "],\"deleted\":[{\"roiUid\":\"x\"}]}", 1));
        regs.save(new RegistrationDocument("PG1", "{\"records\":[]}", 0));
        plugins.save(new PluginDocument("pp", "PG1", "{}"));
        report("rep-pg", "PG1", "pg.a", ReportStatus.FINAL);

        var r = dbAdmin.deletePatient("PG1");

        assertFalse(rois.existsById("PG1"));
        assertFalse(regs.existsById("PG1"));
        assertFalse(plugins.existsById(new PluginDocumentId("pp", "PG1")));
        assertTrue(reports.existsById("rep-pg"), "レポートは消さない");
        assertEquals(1, r.related().pluginDocsRemoved());
    }

    @Test
    void ファイルを残す設定のときは付随データも残す() throws Exception {
        ingest("KP1", "kp.a", "kp.a.s", "kp.a.1");
        rois.save(new RoiDocument("KP1", "{\"rois\":[" + roi("r1", "kp.a.1") + "]}", 1));
        settings.putAll(Map.of("data.deleteFilesOnDisk", "false", RelatedData.calibrationKey("kp.a.s"), "0.6"));
        try {
            var r = dbAdmin.deleteStudy("kp.a");
            assertNull(r.related());
            assertEquals(List.of("r1"), roiUids("KP1"));
            assertEquals("0.6", settings.getAll().get(RelatedData.calibrationKey("kp.a.s")));
        } finally {
            settings.putAll(Map.of("data.deleteFilesOnDisk", "true"));
        }
    }
}
