/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dbtransfer.RelatedData;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.radiomics.GlamAnalysisDocument;
import com.vis.graphynext.radiomics.GlamAnalysisDocumentRepository;
import com.vis.graphynext.report.KeyImageRef;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.report.ReportStatus;
import com.vis.graphynext.report.ReportType;
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
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * シリーズの統合・分割のあと、キー画像・GLAM・XA 校正が新しいシリーズへ追従する。
 * 一意に決まらないもの（分割の GLAM・校正の衝突）は動かさず件数に出す。負例（動かさないもの）を必ず見る。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:seriesrefs;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class SeriesRefsRelocateTest {

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
    ReportRepository reports;
    @Autowired
    GlamAnalysisDocumentRepository glam;
    @Autowired
    SettingsService settings;
    @Autowired
    TransactionTemplate tx;

    private void ingest(String pid, String study, String series, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        ds.setString(Tag.PatientName, VR.PN, pid + "^N");
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian));
    }

    /** keys: {sop, series} の組。 */
    private void report(String id, String pid, String study, String[]... keys) {
        Report r = new Report(id);
        r.setPatientId(pid);
        r.setStudyInstanceUid(study);
        r.setTitle("所見");
        r.setReportType(ReportType.IMAGING_DIAGNOSTIC);
        r.setStatus(ReportStatus.FINAL);
        r.setBodyMarkdown("本文");
        r.setCreatedAt(Instant.parse("2025-01-02T03:04:05Z"));
        r.setUpdatedAt(Instant.parse("2025-01-02T03:04:06Z"));
        int i = 0;
        for (String[] k : keys) {
            r.addKeyImage(new KeyImageRef(id + "-k" + i, k[0], k[1], null, "k" + i, null, i++));
        }
        reports.save(r);
    }

    private void glam(String id, String study, String source, String mask) {
        glam.save(new GlamAnalysisDocument(id, study, source, mask, "L", "{}", 8, 1, 10));
    }

    private Map<String, String> keyImageSeries(String reportId) {
        return tx.execute(s -> reports.findById(reportId).orElseThrow().getKeyImages().stream()
                .collect(Collectors.toMap(KeyImageRef::getSopInstanceUid, KeyImageRef::getSeriesInstanceUid)));
    }

    private String cal(String series) {
        return settings.getAll().get(RelatedData.calibrationKey(series));
    }

    @Test
    void 統合_キー画像とGLAMと校正が統合先へ付き_元の校正キーは消え_別シリーズは動かない() throws Exception {
        for (String s : List.of("a", "b", "c")) {
            ingest("SR1", "sr1.st", "sr1." + s, "sr1." + s + ".1");
        }
        report("rep1", "SR1", "sr1.st", new String[] {"sr1.a.1", "sr1.a"}, new String[] {"sr1.b.1", "sr1.b"},
                new String[] {"sr1.c.1", "sr1.c"});
        glam("g1a", "sr1.st", "sr1.a", "sr1.mask");
        glam("g1c", "sr1.st", "sr1.c", null);
        settings.putAll(Map.of(RelatedData.calibrationKey("sr1.a"), "0.25"));

        var r = dbAdmin.mergeSeries("sr1.st", List.of("sr1.a", "sr1.b"), "sr1.m", null, null);

        assertEquals(Map.of("sr1.a.1", "sr1.m", "sr1.b.1", "sr1.m", "sr1.c.1", "sr1.c"), keyImageSeries("rep1"));
        assertEquals("sr1.m", glam.findById("g1a").orElseThrow().getSourceSeriesUid());
        assertEquals("sr1.mask", glam.findById("g1a").orElseThrow().getMaskSeriesUid(), "別のシリーズ（SEG）は動かさない");
        assertEquals("sr1.c", glam.findById("g1c").orElseThrow().getSourceSeriesUid(), "統合に入れないシリーズを指す GLAM は動かさない");
        assertEquals("0.25", cal("sr1.m"));
        assertNull(cal("sr1.a"), "全部出たので元の校正キーは消す");
        assertEquals(2, r.refs().keyImages());
        assertEquals(1, r.refs().glam());
        assertEquals(1, r.refs().calibrations());
        assertEquals(0, r.refs().calibrationConflicts());
    }

    @Test
    void 統合で元の校正が食い違えば上書きせず衝突として残す() throws Exception {
        for (String s : List.of("a", "b")) {
            ingest("SR2", "sr2.st", "sr2." + s, "sr2." + s + ".1");
        }
        settings.putAll(Map.of(RelatedData.calibrationKey("sr2.a"), "0.25", RelatedData.calibrationKey("sr2.b"), "0.50"));

        var r = dbAdmin.mergeSeries("sr2.st", List.of("sr2.a", "sr2.b"), "sr2.m", null, null);

        assertEquals("0.25", cal("sr2.m"), "先に処理した元の値が付く");
        assertEquals("0.50", cal("sr2.b"), "食い違う方は上書きも削除もしない");
        assertEquals(1, r.refs().calibrationConflicts());
    }

    @Test
    void 分割_移したSOPのキー画像だけ新しいシリーズへ_GLAMは動かさず数え_校正は行き先へコピー() throws Exception {
        for (int i = 1; i <= 4; i++) {
            ingest("SR3", "sr3.st", "sr3.s", "sr3.s." + i);
        }
        report("rep3", "SR3", "sr3.st", new String[] {"sr3.s.1", "sr3.s"}, new String[] {"sr3.s.4", "sr3.s"});
        glam("g3", "sr3.st", "sr3.s", null);
        settings.putAll(Map.of(RelatedData.calibrationKey("sr3.s"), "0.3"));

        var r = dbAdmin.splitSeries("sr3.st", "sr3.s",
                List.of(new DbAdminService.SplitGroup(List.of("sr3.s.1", "sr3.s.2"), null, null)));

        String g = r.newSeriesUids().get(0);
        assertEquals(Map.of("sr3.s.1", g, "sr3.s.4", "sr3.s"), keyImageSeries("rep3"), "動いていない SOP のキー画像は不変");
        assertEquals("sr3.s", glam.findById("g3").orElseThrow().getSourceSeriesUid(), "分割では GLAM を動かさない");
        assertEquals(1, r.refs().glamSkipped());
        assertEquals(0, r.refs().glam());
        assertEquals("0.3", cal(g), "行き先に同じ校正をコピー");
        assertEquals("0.3", cal("sr3.s"), "元のシリーズに残るので元のキーも残す");
    }

    @Test
    void 校正が無いシリーズでは何も作らない() throws Exception {
        ingest("SR4", "sr4.st", "sr4.s", "sr4.s.1");
        ingest("SR4", "sr4.st", "sr4.s", "sr4.s.2");

        var r = dbAdmin.splitSeries("sr4.st", "sr4.s",
                List.of(new DbAdminService.SplitGroup(List.of("sr4.s.1"), null, null)));

        assertNull(cal(r.newSeriesUids().get(0)));
        assertEquals(0, r.refs().calibrations());
        assertFalse(settings.getAll().keySet().stream().anyMatch(k -> k.startsWith("xa.calibration.") && k.contains("sr4")));
    }
}
