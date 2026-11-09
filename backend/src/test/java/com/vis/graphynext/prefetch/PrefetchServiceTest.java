/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import com.vis.graphynext.dbadmin.retention.ProtectionReason;
import com.vis.graphynext.dbadmin.retention.RetentionProtections;
import com.vis.graphynext.dbadmin.retention.StudyStat;
import com.vis.graphynext.dicom.DicomLocalAeService;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.DicomRemoteAeService;
import com.vis.graphynext.dicom.DicomScpServer;
import com.vis.graphynext.dicom.StorageSopClasses;
import com.vis.graphynext.dicom.qr.DimseQrService;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
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

import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 事前取得を、実機 dcm4che の dcmqrscp（PACS）・in-process の MWL SCP・自前の受信 SCP で通す。
 * ツールが無い環境ではスキップ。時計は 2026-11-09 06:00（Asia/Tokyo）に固定する。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:prefetchtest;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.dicom.local-ae-title=GRAPHYNEXT"
        })
class PrefetchServiceTest {

    private static final ZoneId Z = ZoneId.of("Asia/Tokyo");
    private static final Clock CLOCK = Clock.fixed(LocalDateTime.parse("2026-11-09T06:00:00").atZone(Z).toInstant(), Z);

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
    @Autowired PrefetchRunRepository runs;
    @Autowired PrefetchItemRepository items;
    @Autowired PrefetchHoldRepository holds;
    @Autowired DicomStorageService storage;
    @Autowired DicomProperties dicomProps;
    @Autowired RetentionProtections protections;

    private DicomScpServer ownScp;
    private int ownPort;
    private Path csvDir;

    @BeforeEach
    void setUp() throws Exception {
        assumeTrue(FakePacs.available(), "dcm4che ツール未検出のためスキップ");
        settings.deleteByPrefix("prefetch.");
        ownPort = FakePacs.freePort();
        ownScp = new DicomScpServer("GRAPHYNEXT", "127.0.0.1", ownPort);
        List<TransferCapability> caps = StorageSopClasses.scpCapabilities(dicomProps.getStorageSopClassesResource());
        ownScp.addService(new DicomStoreScp(storage, Files.createTempDirectory(tmp, "incoming")),
                caps.toArray(TransferCapability[]::new));
        ownScp.start();
        csvDir = Files.createTempDirectory(tmp, "csv");
    }

    @AfterEach
    void tearDown() {
        if (ownScp != null) {
            ownScp.stop();
        }
    }

    private PrefetchService service() {
        return new PrefetchService(settings, dimse, remoteAes, localAe, instances, runs, items, holds, CLOCK);
    }

    private void remotes(int pacsPort, Integer mwlPort) {
        String json = "[{\"aeTitle\":\"DCMQRSCP\",\"host\":\"127.0.0.1\",\"port\":" + pacsPort + ",\"tls\":false}"
                + (mwlPort == null ? "" : ",{\"aeTitle\":\"RIS\",\"host\":\"127.0.0.1\",\"port\":" + mwlPort + ",\"tls\":false}")
                + "]";
        settings.putAll(Map.of("dicom.remoteAes", json));
    }

    private Map<String, String> base(String source) {
        Map<String, String> m = new HashMap<>();
        m.put(PrefetchConfig.KEY_ENABLED, "true");
        m.put(PrefetchConfig.KEY_SOURCE, source);
        m.put(PrefetchConfig.KEY_TARGET_DAY, "tomorrow");
        m.put(PrefetchConfig.KEY_TIMES, "07:00");
        m.put(PrefetchConfig.KEY_PACS_AE, "DCMQRSCP");
        m.put(PrefetchConfig.KEY_RETRIEVE, "move");
        m.put(PrefetchConfig.KEY_TIMEOUT, "120");
        return m;
    }

    private void csvConfig(Map<String, String> m, String charset) {
        m.put(PrefetchConfig.KEY_CSV_FOLDER, csvDir.toString());
        m.put(PrefetchConfig.KEY_CSV_CHARSET, charset);
        m.put(PrefetchConfig.KEY_CSV_COL_ID, "患者ID");
        m.put(PrefetchConfig.KEY_CSV_COL_DATE, "予約日");
    }

    private static String uid(String s) {
        return "1.2.826.0.1.pf." + s;
    }

    private long have(String study) {
        return instances.countByStudyInstanceUid(study);
    }

    @Test
    void CSV経路_C_MOVE_絞り込みに合う検査だけが取得され_予約日の終わりまで保護される() throws Exception {
        String tag = "a";
        var studies = List.of(
                new FakePacs.Study("P" + tag + "1", uid(tag + "ct"), "CT", "20250101"),
                new FakePacs.Study("P" + tag + "1", uid(tag + "mr"), "MR", "20240101"),
                new FakePacs.Study("P" + tag + "1", uid(tag + "old"), "CT", "20100101"),
                new FakePacs.Study("P" + tag + "2", uid(tag + "ct2"), "CT", "20250601"),
                new FakePacs.Study("P" + tag + "9", uid(tag + "other"), "CT", "20250101"));
        Files.writeString(csvDir.resolve("list.csv"),
                "予約日,患者ID\n2026/11/10,P" + tag + "1\n2026-11-10,P" + tag + "2\n2026/11/11,P" + tag + "9\n",
                Charset.forName("windows-31j"));
        try (FakePacs pacs = FakePacs.start(studies, ownPort)) {
            remotes(pacs.port, null);
            Map<String, String> m = base("csv");
            csvConfig(m, "Shift_JIS");
            m.put(PrefetchConfig.KEY_MODALITIES, "CT");
            m.put(PrefetchConfig.KEY_YEARS, "5");
            settings.putAll(m);

            PrefetchRun r = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);

            assertEquals(PrefetchRun.COMPLETE, r.getStatus(), r.getError());
            assertEquals(2, r.getPatients());
            assertEquals(2, r.getRetrieved(), "CT の 2 件 found=" + r.getFound() + " failed=" + r.getFailed() + " existing=" + r.getExisting() + " items=" + items.findTop500ByRunIdOrderByIdAsc(r.getId()).stream().map(i -> i.getStatus() + ":" + i.getError()).toList());
            assertEquals(1, have(uid(tag + "ct")));
            assertEquals(1, have(uid(tag + "ct2")));
            assertEquals(0, have(uid(tag + "mr")), "モダリティが違う");
            assertEquals(0, have(uid(tag + "old")), "5 年より前");
            assertEquals(0, have(uid(tag + "other")), "予約が明日でない患者");

            long until = LocalDate.of(2026, 11, 11).atStartOfDay(Z).toInstant().toEpochMilli();
            assertTrue(holds.activeStudyUids(until - 1).contains(uid(tag + "ct")), "予約日の終わりまで保護");
            assertTrue(!holds.activeStudyUids(until).contains(uid(tag + "ct")), "翌日 0 時には切れる");

            // 2 回目: ローカルに揃っているので取得しない
            PrefetchRun r2 = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);
            assertEquals(PrefetchRun.COMPLETE, r2.getStatus());
            assertEquals(0, r2.getRetrieved());
            assertEquals(2, r2.getExisting());
        }
    }

    @Test
    void C_GET経路でも取得できる() throws Exception {
        String tag = "g";
        Files.writeString(csvDir.resolve("list.csv"), "予約日,患者ID\n2026/11/10,P" + tag + "1\n", Charset.forName("windows-31j"));
        try (FakePacs pacs = FakePacs.start(List.of(new FakePacs.Study("P" + tag + "1", uid(tag + "ct"), "CT", "20250101")), ownPort)) {
            remotes(pacs.port, null);
            Map<String, String> m = base("csv");
            csvConfig(m, "Shift_JIS");
            m.put(PrefetchConfig.KEY_RETRIEVE, "get");
            settings.putAll(m);
            PrefetchRun r = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);
            assertEquals(PrefetchRun.COMPLETE, r.getStatus(), r.getError());
            assertEquals(1, r.getRetrieved());
            assertEquals(1, have(uid(tag + "ct")));
        }
    }

    @Test
    void MWL経路_ステーションで絞ると該当患者だけ_絞らなければ両方() throws Exception {
        String tag = "m";
        var studies = List.of(
                new FakePacs.Study("P" + tag + "1", uid(tag + "s1"), "CT", "20250101"),
                new FakePacs.Study("P" + tag + "2", uid(tag + "s2"), "CT", "20250101"),
                new FakePacs.Study("P" + tag + "3", uid(tag + "s3"), "CT", "20250101"));
        var entries = List.of(
                new FakeMwl.Entry("P" + tag + "1", "20261110", "CT", "ST1"),
                new FakeMwl.Entry("P" + tag + "2", "20261110", "MR", "ST2"),
                new FakeMwl.Entry("P" + tag + "3", "20261111", "CT", "ST1"));
        try (FakePacs pacs = FakePacs.start(studies, ownPort); FakeMwl mwl = new FakeMwl("RIS", entries)) {
            remotes(pacs.port, mwl.port);
            Map<String, String> m = base("mwl");
            m.put(PrefetchConfig.KEY_MWL_AE, "RIS");
            m.put(PrefetchConfig.KEY_MWL_STATION, "ST1");
            settings.putAll(m);

            var preview = service().previewSchedule();
            assertEquals(Map.of("20261110", 1), preview, "取得はせず件数だけ");
            assertEquals(0, have(uid(tag + "s1")), "プレビューは取得しない");

            PrefetchRun r = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);
            assertEquals(PrefetchRun.COMPLETE, r.getStatus(), r.getError());
            assertEquals(1, have(uid(tag + "s1")));
            assertEquals(0, have(uid(tag + "s2")), "ステーションが違う");
            assertEquals(0, have(uid(tag + "s3")), "予約日が違う");

            settings.putAll(Map.of(PrefetchConfig.KEY_MWL_STATION, ""));
            PrefetchRun r2 = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);
            assertEquals(PrefetchRun.COMPLETE, r2.getStatus(), r2.getError());
            assertEquals(1, have(uid(tag + "s2")), "絞らなければ ST2 も取る");
        }
    }

    @Test
    void 負例_PACSが止まっていれば中断して未処理に数え_復旧後の再実行で取りこぼさない() throws Exception {
        String tag = "d";
        Files.writeString(csvDir.resolve("list.csv"), "予約日,患者ID\n2026/11/10,P" + tag + "1\n2026/11/10,P" + tag + "2\n",
                Charset.forName("windows-31j"));
        Map<String, String> m = base("csv");
        csvConfig(m, "Shift_JIS");
        settings.putAll(m);
        remotes(FakePacs.freePort(), null); // 誰も待ち受けていない口
        PrefetchRun down = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);
        assertEquals(PrefetchRun.INTERRUPTED, down.getStatus());
        assertEquals("pacs-find-failed", down.getError());
        assertEquals(2, down.getPending(), "患者は捨てずに未処理として数える");
        assertEquals(0, down.getRetrieved());

        try (FakePacs pacs = FakePacs.start(List.of(
                new FakePacs.Study("P" + tag + "1", uid(tag + "1"), "CT", "20250101"),
                new FakePacs.Study("P" + tag + "2", uid(tag + "2"), "CT", "20250101")), ownPort)) {
            remotes(pacs.port, null);
            PrefetchRun up = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);
            assertEquals(PrefetchRun.COMPLETE, up.getStatus(), up.getError());
            assertEquals(2, up.getRetrieved());
        }
    }

    @Test
    void 負例_CSVの列名が違えば理由を記録し_何も取得しない() throws Exception {
        Files.writeString(csvDir.resolve("list.csv"), "患者番号,予約日\nPX1,2026/11/10\n", Charset.forName("windows-31j"));
        Map<String, String> m = base("csv");
        csvConfig(m, "Shift_JIS");
        settings.putAll(m);
        remotes(FakePacs.freePort(), null);
        PrefetchRun r = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);
        assertEquals(PrefetchRun.ERROR, r.getStatus());
        assertEquals(CsvAppointments.ERR_NO_ID_COLUMN, r.getError());
        assertEquals(0, r.getFound());
    }

    @Test
    void 負例_文字コードの設定が実際と違えば取得しない() throws Exception {
        Files.writeString(csvDir.resolve("list.csv"), "予約日,患者ID\n2026/11/10,PU1\n", java.nio.charset.StandardCharsets.UTF_8);
        Map<String, String> m = base("csv");
        csvConfig(m, "Shift_JIS"); // 実際は UTF-8
        settings.putAll(m);
        remotes(FakePacs.freePort(), null);
        PrefetchRun r = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);
        assertEquals(PrefetchRun.ERROR, r.getStatus());
        assertTrue(r.getError().startsWith("csv-"), r.getError());
        assertEquals(0, r.getFound());
    }

    @Test
    void 自動削除の保護_期限内の検査には理由が付き_期限を過ぎたものには付かない() {
        long now = System.currentTimeMillis();
        holds.save(new PrefetchHold("1.2.826.0.1.pf.prot.live", now + 3_600_000L));
        holds.save(new PrefetchHold("1.2.826.0.1.pf.prot.expired", now - 3_600_000L));
        var live = new StudyStat("1.2.826.0.1.pf.prot.live", "k1", "k1", "n", "20250101", "CT", 1, 1L, 0L, 0);
        var expired = new StudyStat("1.2.826.0.1.pf.prot.expired", "k2", "k2", "n", "20250101", "CT", 1, 1L, 0L, 0);
        Map<String, Set<ProtectionReason>> prot = protections.collect(List.of(live, expired));
        assertTrue(prot.getOrDefault(live.studyUid(), Set.of()).contains(ProtectionReason.PREFETCH_SCHEDULED));
        assertTrue(!prot.containsKey(expired.studyUid()), "期限を過ぎたら通常の条件に戻る");
    }

    @Test
    void 負例_設定が無効なら実行せず理由を記録する() {
        settings.putAll(Map.of(PrefetchConfig.KEY_ENABLED, "true"));
        PrefetchRun r = service().run(PrefetchService.MANUAL_TRIGGER, PrefetchService.MANUAL);
        assertEquals(PrefetchRun.ERROR, r.getStatus());
        assertTrue(r.getError().startsWith("config:"), r.getError());
    }
}
