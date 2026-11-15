/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dicom.qr.QrProbeService.Request;
import com.vis.graphynext.dicom.qr.QrProbeService.Result;
import org.dcm4che3.data.Tag;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** 通信テスト（疎通・検索のパターン・GET/MOVE の許可）を、振る舞いの違う偽の相手で確かめる。 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:qrprobe;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.dicom.local-ae-title=GRAPHYNEXT"
        })
class QrProbeIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    QrProbeService probe;

    @BeforeAll
    static void check(@Autowired Dcm4cheTools t) {
        assumeTrue(t.isAvailable("findscu") && t.isAvailable("getscu") && t.isAvailable("movescu"),
                "dcm4che ツール未検出のためスキップ");
    }

    private static Request req(int port, String aet, String patientId, String uid) {
        return new Request("127.0.0.1", port, aet, false, patientId, null, uid);
    }

    @Test
    void pspStylePeer_showsWhichPatternsPass_andLeaksNoPatientValues() throws Exception {
        try (FakeQrScp s = FakeQrScp.start("RELAY", FakeQrScp.Behavior.DROP_ON_KEYS, false, true, 0,
                Set.of(Tag.NumberOfStudyRelatedSeries, Tag.NumberOfStudyRelatedInstances), false, null)) {
            Request r = req(s.port, "RELAY", null, null);
            assertEquals("ok", probe.run("echo", r).verdict());

            Result minimal = probe.run("find-minimal", r);
            assertEquals("ok", minimal.verdict());
            assertEquals(1, minimal.count());
            assertEquals(List.of("StudyInstanceUID"), minimal.returnedKeys());
            assertEquals("1.2.fake.study", minimal.sampleStudyUid());
            assertNotNull(minimal.adopt());
            assertEquals(FindProfile.MINIMAL_STUDY, minimal.adopt().studyKeys());

            Result basic = probe.run("find-basic", r);
            assertEquals("ok", basic.verdict());
            assertTrue(basic.returnedKeys().containsAll(List.of("StudyInstanceUID", "PatientID", "PatientName")));

            // 標準の項目（NumberOfStudyRelated* を含む）は、この相手では切られる
            Result standard = probe.run("find-standard", r);
            assertEquals("ng", standard.verdict());
            assertEquals("DROPPED", standard.kind());
            assertEquals(null, standard.adopt());

            // 前提が無い段は、試さない
            assertEquals("skipped", probe.run("find-patientroot-study", r).verdict());
            assertEquals("skipped", probe.run("find-series", r).verdict());
            // Series は、見つかった検査の UID があれば試せる
            assertEquals("ok", probe.run("find-series", req(s.port, "RELAY", null, minimal.sampleStudyUid())).verdict());

            // この相手は GET/MOVE を受けない
            assertEquals("ng", probe.run("get", r).verdict());
            assertEquals("SERVICE_REFUSED", probe.run("move", r).kind());

            String json = new ObjectMapper().writeValueAsString(
                    List.of(minimal, basic, standard, probe.run("get", r)));
            assertFalse(json.contains("FAKE^PATIENT"), "患者名が結果に入っている");
            assertFalse(json.contains("FAKE1"), "患者 ID が結果に入っている");
        }
    }

    @Test
    void getAndMove_allowed_and_moveDestinationUnregistered() throws Exception {
        try (FakeQrScp s = FakeQrScp.start("PEER", FakeQrScp.Behavior.NORMAL, false, true, 0, Set.of(), true,
                Set.of("GRAPHYNEXT"))) {
            Request r = req(s.port, "PEER", null, null);
            assertEquals("ok", probe.run("get", r).verdict());
            assertEquals("ok", probe.run("move", r).verdict());
        }
        // 宛先 AE（自局）が相手に登録されていない: MOVE は受け付けたが a801H
        try (FakeQrScp s = FakeQrScp.start("PEER", FakeQrScp.Behavior.NORMAL, false, true, 0, Set.of(), true,
                Set.of("OTHER"))) {
            Result m = probe.run("move", req(s.port, "PEER", null, null));
            assertEquals("warn", m.verdict());
            assertEquals(0xA801, m.status());
            assertEquals("ok", probe.run("get", req(s.port, "PEER", null, null)).verdict());
        }
    }

    @Test
    void patientRootStudyStep_runsWithPatientId_andPeerThatRefusesFind() throws Exception {
        try (FakeQrScp s = FakeQrScp.start("PEER", FakeQrScp.Behavior.NORMAL, true, false, 0, Set.of(), false, null)) {
            Request r = req(s.port, "PEER", "ANY", null);
            assertEquals("ng", probe.run("find-minimal", r).verdict());
            assertEquals("SERVICE_REFUSED", probe.run("find-minimal", r).kind());
            Result pr = probe.run("find-patientroot", r);
            assertEquals("ok", pr.verdict());
            assertEquals("PatientRoot", pr.adopt().model());
            assertEquals("ok", probe.run("find-patientroot-study", r).verdict());
            assertTrue(pr.command().contains("-M PatientRoot"));
            assertFalse(pr.command().contains("ANY"), "患者 ID が報告用のコマンドに入っている");
        }
    }

    @Test
    void echoToNowhere_isNgUnreachable() {
        Result e = probe.run("echo", req(59997, "X", null, null));
        assertEquals("ng", e.verdict());
        assertEquals("UNREACHABLE", e.kind(), e.reason());
    }

    @Test
    void errorStatusIsReportedWithStatus() throws Exception {
        try (FakeQrScp s = FakeQrScp.start("PEER", FakeQrScp.Behavior.ERROR_STATUS, false, true, 0xA900, Set.of(), false, null)) {
            Result f = probe.run("find-minimal", req(s.port, "PEER", null, null));
            assertEquals("ng", f.verdict());
            assertEquals("STATUS_ERROR", f.kind());
            assertEquals(0xA900, f.status());
            assertTrue(f.evidence().contains("status=a900H"), f.evidence());
        }
    }
}
