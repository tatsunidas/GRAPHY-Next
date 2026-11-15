/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import com.vis.graphynext.dicom.DicomLocalAeService;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.DicomRemoteAeService;
import com.vis.graphynext.dicom.DicomScpServer;
import com.vis.graphynext.dicom.StorageSopClasses;
import com.vis.graphynext.dicom.qr.DimseQrService;
import com.vis.graphynext.dicom.qr.FakeQrScp;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
import com.vis.graphynext.prefetch.FakePacs;
import com.vis.graphynext.prefetch.PrefetchHoldRepository;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 電子カルテ連携の先取りを、実機 dcm4che の dcmqrscp（PACS）と自前の受信 SCP で通す。
 * ツールが無い環境ではスキップ。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:emrprefetch;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.dicom.local-ae-title=GRAPHYNEXT"
        })
class EmrPrefetchServiceTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired SettingsService settings;
    @Autowired DimseQrService dimse;
    @Autowired DicomRemoteAeService remoteAes;
    @Autowired DicomLocalAeService localAe;
    @Autowired DicomInstanceRepository instances;
    @Autowired PrefetchHoldRepository holds;
    @Autowired DicomStorageService storage;
    @Autowired DicomProperties dicomProps;

    private DicomScpServer ownScp;
    private int ownPort;
    private EmrPrefetchService svc;

    @BeforeEach
    void setUp() throws Exception {
        assumeTrue(FakePacs.available(), "dcm4che ツール未検出のためスキップ");
        ownPort = FakePacs.freePort();
        ownScp = new DicomScpServer("GRAPHYNEXT", "127.0.0.1", ownPort);
        List<TransferCapability> caps = StorageSopClasses.scpCapabilities(dicomProps.getStorageSopClassesResource());
        ownScp.addService(new DicomStoreScp(storage, Files.createTempDirectory(tmp, "incoming")),
                caps.toArray(TransferCapability[]::new));
        ownScp.start();
        svc = new EmrPrefetchService(settings::getAll, dimse, remoteAes, localAe, instances, holds, Clock.systemDefaultZone());
    }

    @AfterEach
    void tearDown() {
        if (ownScp != null) {
            ownScp.stop();
        }
        if (svc != null) {
            svc.shutdown();
        }
    }

    private void configure(int pacsPort, String ae) {
        settings.putAll(Map.of("dicom.remoteAes",
                "[{\"aeTitle\":\"" + ae + "\",\"host\":\"127.0.0.1\",\"port\":" + pacsPort + ",\"tls\":false}]"));
        Map<String, String> m = new HashMap<>();
        m.put(EmrConfig.KEY_ENABLED, "true");
        m.put(EmrConfig.KEY_PATH, "unused");
        m.put(EmrConfig.KEY_FORMAT, "csv");
        m.put(EmrConfig.KEY_CHARSET, "UTF-8");
        m.put(EmrConfig.KEY_CSV_COLUMN, "1");
        m.put(EmrConfig.KEY_PACS_AE, ae);
        m.put(EmrConfig.KEY_RETRIEVE, "move");
        m.put(EmrConfig.KEY_TIMEOUT, "120");
        settings.putAll(m);
    }

    private static boolean until(BooleanSupplier c, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (c.getAsBoolean()) {
                return true;
            }
            Thread.sleep(25);
        }
        return c.getAsBoolean();
    }

    private static String uid(String s) {
        return "1.2.826.0.1.emr." + s;
    }

    private long received(String studyUid) {
        return instances.findAll().stream().filter(i -> studyUid.equals(i.getStudyInstanceUid()))
                .mapToLong(i -> i.getReceivedAt() == null ? 0 : i.getReceivedAt()).min().orElse(-1);
    }

    private long count(String studyUid) {
        return instances.countByStudyInstanceUid(studyUid);
    }

    @Test
    void latestStudyFirst_thenTheRest_allProtected_otherPatientsUntouched() throws Exception {
        String p = "EP1";
        String old = uid("a-old"), mid = uid("a-mid"), latest = uid("a-latest"), other = uid("a-other");
        try (FakePacs pacs = FakePacs.start(List.of(
                new FakePacs.Study(p, old, "CT", "20240101"),
                new FakePacs.Study(p, latest, "CT", "20250601"),
                new FakePacs.Study(p, mid, "MR", "20250101"),
                new FakePacs.Study("EP-OTHER", other, "CT", "20250301")), ownPort)) {
            configure(pacs.port, "DCMQRSCP");
            svc.request(p, 1);
            assertTrue(until(() -> "done".equals(svc.state().state()), 90_000), String.valueOf(svc.state()));

            EmrPrefetchService.FetchState s = svc.state();
            assertEquals(3, s.found());
            assertEquals(3, s.retrieved());
            assertEquals(latest, s.latestStudyUid());
            assertTrue(s.latestReady());
            for (String u : List.of(old, mid, latest)) {
                assertEquals(1, count(u), u);
            }
            assertEquals(0, count(other), "別の患者の検査は取らない");
            // 取った順: 直近が最初、そのあと新しい順（受信時刻の昇順）
            assertTrue(received(latest) < received(mid) && received(mid) < received(old),
                    "latest=" + received(latest) + " mid=" + received(mid) + " old=" + received(old));
            // 自動削除からの保護が、取る前に付いている
            long now = System.currentTimeMillis();
            for (String u : List.of(old, mid, latest)) {
                assertTrue(holds.findById(u).orElseThrow().getUntilMs() > now + 24L * 3600 * 1000, "保護 " + u);
            }
            assertTrue(holds.findById(other).isEmpty());

            // もう一度頼むと、揃っているので取り直さない（受信時刻が変わらない）
            long before = received(latest);
            svc.request(p, 1);
            assertTrue(until(() -> "done".equals(svc.state().state()) && svc.state().retrieved() == 3, 30_000));
            assertEquals(before, received(latest));
            assertEquals(1, count(latest));
        }
    }

    @Test
    void unknownPatient_isNotFound_andNoStudiesAreStored() throws Exception {
        try (FakePacs pacs = FakePacs.start(List.of(new FakePacs.Study("EP2", uid("b1"), "CT", "20250101")), ownPort)) {
            configure(pacs.port, "DCMQRSCP");
            svc.request("NOBODY", 1);
            assertTrue(until(() -> "not-found".equals(svc.state().state()), 30_000), String.valueOf(svc.state()));
            assertEquals(0, count(uid("b1")));
            assertEquals(false, svc.state().latestReady());
        }
    }

    @Test
    void newestRequestWins_theOldPatientsRemainingStudiesAreNotFetched() throws Exception {
        List<FakePacs.Study> many = new java.util.ArrayList<>();
        for (int i = 0; i < 8; i++) {
            many.add(new FakePacs.Study("EP3", uid("c" + i), "CT", String.format("2025%02d01", i + 1)));
        }
        many.add(new FakePacs.Study("EP4", uid("d1"), "CT", "20250101"));
        try (FakePacs pacs = FakePacs.start(many, ownPort)) {
            configure(pacs.port, "DCMQRSCP");
            svc.request("EP3", 1);
            assertTrue(until(() -> "EP3".equals(svc.state().patientId()) && svc.state().retrieved() >= 1, 60_000));
            svc.request("EP4", 2); // 患者が切り替わった
            assertTrue(until(() -> "EP4".equals(svc.state().patientId()) && "done".equals(svc.state().state()), 90_000),
                    String.valueOf(svc.state()));
            assertEquals(1, count(uid("d1")));
            long got = many.stream().filter(s -> s.patientId().equals("EP3")).filter(s -> count(s.studyUid()) > 0).count();
            assertTrue(got >= 1 && got < 8, "古い患者の残りは止まる: 取れた検査 " + got + " / 8");
            // 状態は、新しい患者のもの（古い要求が上書きしない）
            Thread.sleep(500);
            assertEquals("EP4", svc.state().patientId());
            assertEquals("done", svc.state().state());
        }
    }

    @Test
    void findFailureIsReportedWithItsKind_andNothingIsFetched() throws Exception {
        try (FakeQrScp peer = FakeQrScp.start("DCMQRSCP", FakeQrScp.Behavior.ERROR_STATUS, false, true, 0xA900,
                Set.of(), false, null)) {
            configure(peer.port, "DCMQRSCP");
            svc.request("EP5", 1);
            assertTrue(until(() -> "error".equals(svc.state().state()), 30_000), String.valueOf(svc.state()));
            assertEquals("find-failed:STATUS_ERROR", svc.state().error());
        }
        try (FakeQrScp peer = FakeQrScp.start("DCMQRSCP", FakeQrScp.Behavior.DROP_ON_KEYS, false, true, 0,
                Set.of(org.dcm4che3.data.Tag.NumberOfStudyRelatedSeries), false, null)) {
            configure(peer.port, "DCMQRSCP");
            svc.request("EP6", 2);
            assertTrue(until(() -> "error".equals(svc.state().state()) && "EP6".equals(svc.state().patientId()), 30_000));
            assertEquals("find-failed:DROPPED", svc.state().error());
        }
    }

    @Test
    void disabledOrUnknownPacsIsAnError() throws Exception {
        settings.putAll(Map.of(EmrConfig.KEY_ENABLED, "false"));
        svc.request("EP7", 1);
        assertTrue(until(() -> "error".equals(svc.state().state()), 10_000));
        assertEquals("config", svc.state().error());
        configure(1, "NOPE");
        settings.putAll(Map.of(EmrConfig.KEY_PACS_AE, "NOT-REGISTERED"));
        svc.request("EP8", 2);
        assertTrue(until(() -> "pacs-ae-not-found".equals(svc.state().error()), 10_000), String.valueOf(svc.state()));
    }

    @Test
    void samePatientWhileRunning_isIgnored() throws Exception {
        try (FakePacs pacs = FakePacs.start(List.of(
                new FakePacs.Study("EP9", uid("e1"), "CT", "20250101"),
                new FakePacs.Study("EP9", uid("e2"), "CT", "20250201")), ownPort)) {
            configure(pacs.port, "DCMQRSCP");
            svc.request("EP9", 1);
            svc.request("EP9", 1); // 取り込み中の同じ患者は、重ねない
            assertTrue(until(() -> "done".equals(svc.state().state()), 60_000));
            assertEquals(1, count(uid("e1")));
            assertEquals(2, svc.state().found());
        }
    }
}
