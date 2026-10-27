/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomSendService;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScu;
import com.vis.graphynext.report.KeyImageRef;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.report.ReportStatus;
import com.vis.graphynext.report.ReportType;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.PDVInputStream;
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicCStoreSCP;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DICOM 送信の「キー画像のみ」。確定済みレポートのキー画像（と KO）だけが相手に届き、
 * 下書き・キー画像の無いスタディは送られず、理由が結果に出ること。
 * 受信側は保管庫と切り離した SCP で、届いた SOP Instance UID を直接数える。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:sendki;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DicomSendKeyImagesTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;

    @Autowired
    DicomSendService sendService;

    @Autowired
    ReportRepository reports;

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }

    private void ingest(String study, String series, String sop) throws Exception {
        Path f = Files.createTempFile("ki", ".dcm");
        storage.ingest(DicomPhantomFactory.writeFile(f, DicomPhantomFactory.scImage("PKI", study, series, sop),
                UID.ExplicitVRLittleEndian));
    }

    private void report(String study, ReportStatus status, String ko, KeyImageRef... keys) {
        Report r = new Report(java.util.UUID.randomUUID().toString());
        r.setPatientId("PKI");
        r.setStudyInstanceUid(study);
        r.setReportType(ReportType.GENERAL);
        r.setStatus(status);
        r.setBodyMarkdown("x");
        r.setCreatedAt(Instant.now());
        r.setUpdatedAt(Instant.now());
        r.setKoSopInstanceUid(ko);
        for (KeyImageRef k : keys) {
            r.addKeyImage(k);
        }
        reports.save(r);
    }

    private static KeyImageRef key(String sop, String series, Integer frame, int order) {
        return new KeyImageRef(java.util.UUID.randomUUID().toString(), sop, series, frame, null, null, order);
    }

    /** 届いた SOP Instance UID を集めるだけの SCP。 */
    private static com.vis.graphynext.dicom.DicomScpServer collector(int port, Set<String> got) throws Exception {
        var server = new DicomScpServer("RCVSCP", "127.0.0.1", port);
        server.addService(new BasicCStoreSCP("*") {
            @Override
            protected void store(Association as, PresentationContext pc, Attributes rq, PDVInputStream data, Attributes rsp)
                    throws IOException {
                got.add(rq.getString(Tag.AffectedSOPInstanceUID));
                data.copyTo(OutputStream.nullOutputStream());
            }
        }, new TransferCapability(null, "*", TransferCapability.Role.SCP, "*"));
        server.start();
        return server;
    }

    private DicomSendService.SendSummary send(String study, boolean keyOnly, boolean includeKo, Set<String> got)
            throws Exception {
        int port = freePort();
        var server = collector(port, got);
        try {
            return sendService.send(List.of(new DicomSendService.Selection(study, List.of())), "127.0.0.1", port,
                    "RCVSCP", "SENDER", false,
                    new DicomSendService.Options(DicomStoreScu.TsPolicy.STORED, keyOnly, includeKo));
        } finally {
            server.stop();
        }
    }

    @Test
    void 確定済みレポートのキー画像とKOだけが届く_下書きの参照は届かない() throws Exception {
        for (String sop : List.of("SOP.K1a", "SOP.K1b", "SOP.K1c")) {
            ingest("ST.KI1", "SE.K1", sop);
        }
        ingest("ST.KI1", "SE.KO", "SOP.KO1");
        report("ST.KI1", ReportStatus.FINAL, "SOP.KO1", key("SOP.K1b", "SE.K1", null, 0));
        report("ST.KI1", ReportStatus.DRAFT, null, key("SOP.K1c", "SE.K1", null, 0));

        Set<String> got = ConcurrentHashMap.newKeySet();
        var s = send("ST.KI1", true, true, got);

        assertEquals(Set.of("SOP.K1b", "SOP.KO1"), got, s.messages().toString());
        assertEquals(2, s.sent());
        assertEquals(0, s.failed());
    }

    @Test
    void KOを送らない指定ならキー画像だけ() throws Exception {
        ingest("ST.KI2", "SE.K2", "SOP.K2a");
        ingest("ST.KI2", "SE.K2", "SOP.K2b");
        ingest("ST.KI2", "SE.KO", "SOP.KO2");
        report("ST.KI2", ReportStatus.FINAL, "SOP.KO2", key("SOP.K2a", "SE.K2", null, 0));

        Set<String> got = ConcurrentHashMap.newKeySet();
        var s = send("ST.KI2", true, false, got);

        assertEquals(Set.of("SOP.K2a"), got, s.messages().toString());
    }

    @Test
    void 対照_キー画像のみでなければスタディ全体が届く() throws Exception {
        ingest("ST.KI3", "SE.K3", "SOP.K3a");
        ingest("ST.KI3", "SE.K3", "SOP.K3b");
        report("ST.KI3", ReportStatus.FINAL, null, key("SOP.K3a", "SE.K3", null, 0));

        Set<String> got = ConcurrentHashMap.newKeySet();
        send("ST.KI3", false, true, got);

        assertEquals(Set.of("SOP.K3a", "SOP.K3b"), got);
    }

    @Test
    void レポートが無い_下書きだけのスタディは送らず_理由が出る() throws Exception {
        ingest("ST.KI4", "SE.K4", "SOP.K4a");
        ingest("ST.KI5", "SE.K5", "SOP.K5a");
        report("ST.KI5", ReportStatus.DRAFT, null, key("SOP.K5a", "SE.K5", null, 0));

        for (String st : List.of("ST.KI4", "ST.KI5")) {
            Set<String> got = ConcurrentHashMap.newKeySet();
            var s = send(st, true, true, got);
            assertTrue(got.isEmpty(), st + " は何も送られない");
            assertEquals(0, s.sent());
            assertTrue(s.messages().stream().anyMatch(m -> m.contains("キー画像がないため送りません")), s.messages().toString());
        }
    }

    @Test
    void フレーム指定はインスタンス全体を送り_注記が出る() throws Exception {
        ingest("ST.KI6", "SE.K6", "SOP.K6a");
        report("ST.KI6", ReportStatus.FINAL, null, key("SOP.K6a", "SE.K6", 2, 0));

        Set<String> got = ConcurrentHashMap.newKeySet();
        var s = send("ST.KI6", true, true, got);

        assertEquals(Set.of("SOP.K6a"), got);
        assertEquals(0, s.failed());
        assertTrue(s.messages().stream().anyMatch(m -> m.contains("特定フレーム")), s.messages().toString());
    }

    @Test
    void 保管庫に無い参照は失敗に数える_ほかは届く() throws Exception {
        ingest("ST.KI7", "SE.K7", "SOP.K7a");
        report("ST.KI7", ReportStatus.FINAL, null, key("SOP.K7a", "SE.K7", null, 0), key("SOP.K7gone", "SE.K7", null, 1));

        Set<String> got = ConcurrentHashMap.newKeySet();
        var s = send("ST.KI7", true, true, got);

        assertEquals(Set.of("SOP.K7a"), got);
        assertEquals(1, s.sent());
        assertEquals(1, s.failed());
        assertEquals(2, s.total());
        assertTrue(s.messages().stream().anyMatch(m -> m.contains("SOP.K7gone")), s.messages().toString());
    }
}
