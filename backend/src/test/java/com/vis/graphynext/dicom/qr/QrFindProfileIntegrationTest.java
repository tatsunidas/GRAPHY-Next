/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.qr.DimseOutcome.Kind;
import org.dcm4che3.data.Tag;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Path;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 通信先ごとの検索方式を、偽の Q/R SCP（{@link FakeQrScp}）に実物の findscu を向けて確かめる。
 * 実例（中継サーバー: C-FIND を送ると応答せず切断）を、再現できる形にして、
 * 既定の検索は落ち（負例）、最小の返却キーなら通る（正例）ことを示す。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:qrfindprofile;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.dicom.local-ae-title=GRAPHYNEXT"
        })
class QrFindProfileIntegrationTest {

    @TempDir
    static Path tmp;

    /** 切断型: NumberOfStudyRelated* が要求に入っていると、応答せず切る。 */
    static FakeQrScp psp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
        psp = FakeQrScp.start("RELAY", FakeQrScp.Behavior.DROP_ON_KEYS, false, true, 0,
                Set.of(Tag.NumberOfStudyRelatedSeries, Tag.NumberOfStudyRelatedInstances), false, null);
        // 登録済みの通信先に検索方式（最小の返却キー）を持たせる: 既定の経路でそれが効くことの確認用
        r.add("graphy.dicom.remote-aes[0].ae-title", () -> "RELAY");
        r.add("graphy.dicom.remote-aes[0].host", () -> "127.0.0.1");
        r.add("graphy.dicom.remote-aes[0].port", () -> String.valueOf(psp.port));
        r.add("graphy.dicom.remote-aes[0].find.study-keys[0]", () -> "StudyInstanceUID");
        r.add("graphy.dicom.remote-aes[0].find.study-keys[1]", () -> "PatientID");
    }

    @AfterAll
    static void stop() {
        psp.close();
    }

    @Autowired
    DimseQrService qr;
    @Autowired
    Dcm4cheTools tools;

    @BeforeAll
    static void check(@Autowired Dcm4cheTools t) {
        assumeTrue(t.isAvailable("findscu"), "dcm4che ツール未検出のためスキップ");
    }

    @Test
    void pspStyleDrop_defaultFails_minimalKeysPass() throws Exception {
        QrFindException e = assertThrows(QrFindException.class,
                () -> qr.findStudiesForQr("127.0.0.1", psp.port, "RELAY", Map.of(), false, FindProfile.DEFAULT));
        assertEquals(Kind.DROPPED, e.outcome().kind(), e.getMessage());

        var rows = qr.findStudiesForQr("127.0.0.1", psp.port, "RELAY", Map.of(), false,
                FindProfile.DEFAULT.withKeys(null, FindProfile.MINIMAL_STUDY, null));
        assertEquals(1, rows.size());
        assertEquals("1.2.fake.study", rows.get(0).studyInstanceUid());
    }

    @Test
    void registeredRemoteProfile_isUsedByTheDefaultEntryPoint() throws Exception {
        // 設定を触らない呼び出し（Q/R 画面・事前取得と同じ入口）でも、通信先の登録に従って通る
        var rows = qr.findStudiesForQr("127.0.0.1", psp.port, "RELAY", Map.of(), false);
        assertEquals(1, rows.size());
        assertEquals("FAKE1", rows.get(0).patientId());
    }

    @Test
    void errorStatusIsAnErrorNotZeroHits() throws Exception {
        try (FakeQrScp s = FakeQrScp.start("PEER", FakeQrScp.Behavior.ERROR_STATUS, false, true, 0xA900, Set.of(), false, null)) {
            QrFindException e = assertThrows(QrFindException.class,
                    () -> qr.findStudiesForQr("127.0.0.1", s.port, "PEER", Map.of(), false, FindProfile.DEFAULT));
            assertEquals(Kind.STATUS_ERROR, e.outcome().kind());
            assertEquals(0xA900, e.outcome().status());
        }
    }

    @Test
    void serviceRefused() throws Exception {
        try (FakeQrScp s = FakeQrScp.start("PEER", FakeQrScp.Behavior.NO_QR, false, true, 0, Set.of(), false, null)) {
            QrFindException e = assertThrows(QrFindException.class,
                    () -> qr.findStudiesForQr("127.0.0.1", s.port, "PEER", Map.of(), false, FindProfile.DEFAULT));
            assertEquals(Kind.SERVICE_REFUSED, e.outcome().kind());
        }
    }

    @Test
    void patientRootOnlyPeer_patientThenStudyFlow() throws Exception {
        try (FakeQrScp s = FakeQrScp.start("PEER", FakeQrScp.Behavior.NORMAL, true, false, 0, Set.of(), false, null)) {
            // 既定（Study Root）は断られる
            assertEquals(Kind.SERVICE_REFUSED, assertThrows(QrFindException.class,
                    () -> qr.findStudiesForQr("127.0.0.1", s.port, "PEER", Map.of(), false, FindProfile.DEFAULT))
                    .outcome().kind());
            // Patient Root: 患者 ID なし → PATIENT 段で患者を引き、患者ごとに STUDY 段
            var rows = qr.findStudiesForQr("127.0.0.1", s.port, "PEER", Map.of("StudyDate", "20261114"), false,
                    FindProfile.DEFAULT.withModel("PatientRoot"));
            assertEquals(1, rows.size());
            assertTrue(s.lastFindSopClass.contains("1.2.840.10008.5.1.4.1.2.1.1"), "Patient Root で引いたはず");
            assertEquals("STUDY", s.lastFindKeys.getString(Tag.QueryRetrieveLevel));
            assertEquals("FAKE1", s.lastFindKeys.getString(Tag.PatientID));
            // 患者 ID あり → STUDY 段を 1 回だけ
            var rows2 = qr.findStudiesForQr("127.0.0.1", s.port, "PEER", Map.of("PatientID", "FAKE1"), false,
                    FindProfile.DEFAULT.withModel("PatientRoot"));
            assertEquals(1, rows2.size());
        }
    }
}
