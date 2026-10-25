/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import com.vis.graphynext.dbadmin.DbAdminService;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.plugin.store.PluginDocument;
import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.radiomics.GlamAnalysisDocument;
import com.vis.graphynext.radiomics.GlamAnalysisDocumentRepository;
import com.vis.graphynext.registration.RegistrationDocument;
import com.vis.graphynext.registration.RegistrationDocumentRepository;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.roi.RoiDocument;
import com.vis.graphynext.roi.RoiDocumentRepository;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 自動削除の段 1（受信日時・保護の収集・試算・条件の保存・ロック）。実際の DB と保管庫を使い、<b>何も消えないこと</b>を
 * ファイル数・索引の件数で確かめる。時計は差し替える。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:retention;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class RetentionServiceTest {

    private static final long DAY = 24L * 60 * 60 * 1000;

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired DicomStorageService storage;
    @Autowired DicomInstanceRepository repo;
    @Autowired StorageLayout layout;
    @Autowired DbAdminService dbAdmin;
    @Autowired RetentionService service;
    @Autowired InUseRegistry inUse;
    @Autowired StudyRetentionHoldRepository holds;
    @Autowired ReportRepository reports;
    @Autowired GlamAnalysisDocumentRepository glam;
    @Autowired RoiDocumentRepository rois;
    @Autowired RegistrationDocumentRepository registrations;
    @Autowired PluginDocumentRepository plugins;
    @Autowired SettingsService settings;
    /** 空きは実ディスクに依らず、テストで決める。 */
    @MockBean FreeSpaceProvider freeSpace;

    /** JUnit はテストごとにインスタンスを作るので、UID が重ならないよう static にする（共有の DB に溜まる）。 */
    private static final AtomicInteger seq = new AtomicInteger();

    @AfterEach
    void restoreClock() {
        storage.setClock(Clock.systemUTC());
    }

    /** 1 検査（1 画像）を取り込む。patientId を渡すとその患者の検査になる。 */
    private String ingest(String patientId, long receivedAtMs) throws Exception {
        String n = String.valueOf(seq.incrementAndGet());
        String study = "1.9.9." + n;
        String sop = study + ".1";
        storage.setClock(Clock.fixed(Instant.ofEpochMilli(receivedAtMs), ZoneOffset.UTC));
        Attributes ds = DicomPhantomFactory.scImage(patientId, study, study + ".s", sop);
        ds.setString(Tag.PatientName, VR.PN, "Name^" + n);
        ds.setString(Tag.Modality, VR.CS, "CT");
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian));
        return study;
    }

    private static long filesUnder(Path root) throws Exception {
        try (Stream<Path> s = Files.walk(root)) {
            return s.filter(Files::isRegularFile).count();
        }
    }

    private static List<String> uids(RetentionPlan p) {
        return p.items().stream().map(RetentionPlan.Item::studyUid).toList();
    }

    private void days(int d) {
        service.saveConfig(new RetentionConfig(d, null, null));
    }

    // ── 受信日時 ──

    @Test
    void 受信日時は取り込みで入り_再受信で新しくなる() throws Exception {
        long t1 = 1_700_000_000_000L;
        String study = ingest("RCV1", t1);
        String sop = study + ".1";
        assertEquals(t1, repo.findById(sop).orElseThrow().getReceivedAt());

        storage.setClock(Clock.fixed(Instant.ofEpochMilli(t1 + 5 * DAY), ZoneOffset.UTC));
        Attributes ds = DicomPhantomFactory.scImage("RCV1", study, study + ".s", sop);
        ds.setString(Tag.Modality, VR.CS, "CT");
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian));
        assertEquals(t1 + 5 * DAY, repo.findById(sop).orElseThrow().getReceivedAt(), "再受信は最後の受信日時");
    }

    @Test
    void 患者編集では受信日時が変わらない() throws Exception {
        long t = 1_700_000_000_000L;
        String study = ingest("RCV2", t);
        dbAdmin.updatePatient("RCV2", "New^Name", "19800101", "M", null);
        assertEquals(t, repo.findById(study + ".1").orElseThrow().getReceivedAt());
    }

    @Test
    void 埋め戻しはファイルの更新時刻で埋め_ファイルが無い行はnullのまま() throws Exception {
        String a = ingest("BF1", 1_700_000_000_000L);
        String b = ingest("BF1", 1_700_000_000_000L);
        DicomInstance ra = repo.findById(a + ".1").orElseThrow();
        DicomInstance rb = repo.findById(b + ".1").orElseThrow();
        ra.setReceivedAt(null);
        rb.setReceivedAt(null);
        repo.save(ra);
        repo.save(rb);
        long mtime = 1_650_000_000_000L;
        Files.setLastModifiedTime(layout.resolveForWrite(ra), FileTime.fromMillis(mtime));
        Files.delete(layout.resolveForWrite(rb));

        int filled = storage.backfillReceivedAt();
        assertTrue(filled >= 1);
        assertEquals(mtime, repo.findById(a + ".1").orElseThrow().getReceivedAt(), "更新時刻で埋まる");
        assertNull(repo.findById(b + ".1").orElseThrow().getReceivedAt(), "ファイルが無い行は日付を作らない");
        storage.backfillReceivedAt(); // 2 回目も壊さない
        assertEquals(mtime, repo.findById(a + ".1").orElseThrow().getReceivedAt());
        assertNull(repo.findById(b + ".1").orElseThrow().getReceivedAt());
    }

    // ── 試算 ──

    @Test
    void 試算は何も消さない_ファイル数も索引も同じ() throws Exception {
        long now = System.currentTimeMillis();
        for (int i = 0; i < 3; i++) {
            ingest("PRV" + i, now - 400 * DAY);
        }
        days(30);
        long files = filesUnder(tmp.resolve("store"));
        long rows = repo.count();
        RetentionPlan p = service.preview();
        assertTrue(p.items().size() >= 3, "試算には消える検査が出る");
        assertEquals(files, filesUnder(tmp.resolve("store")), "ファイル数が前後で同じ");
        assertEquals(rows, repo.count(), "索引の件数が前後で同じ");
    }

    @Test
    void 条件が空なら_受信が古くても何も選ばない() throws Exception {
        ingest("OFF1", System.currentTimeMillis() - 900 * DAY);
        service.saveConfig(new RetentionConfig(null, null, null));
        org.mockito.Mockito.when(freeSpace.usableBytes()).thenReturn(0L);
        assertTrue(service.preview().items().isEmpty());
    }

    @Test
    void 日数_31日前は選ばれ29日前は選ばれない() throws Exception {
        long now = System.currentTimeMillis();
        String old = ingest("D31", now - 31 * DAY);
        String recent = ingest("D29", now - 29 * DAY);
        days(30);
        RetentionPlan p = service.preview();
        assertTrue(uids(p).contains(old));
        assertFalse(uids(p).contains(recent));
    }

    @Test
    void 判定の開始後に受信した検査は_条件に当たっても選ばれない() throws Exception {
        String early = ingest("RCVEARLY", System.currentTimeMillis() - 5 * DAY);
        String fresh = ingest("RCVFRESH", System.currentTimeMillis() + 3_600_000L); // 判定の開始より後
        org.mockito.Mockito.when(freeSpace.usableBytes()).thenReturn(0L); // 空きの条件は、新しい検査にも当たる
        service.saveConfig(new RetentionConfig(null, null, 1.0));
        RetentionPlan p = service.preview();
        assertTrue(uids(p).contains(early));
        assertFalse(uids(p).contains(fresh));
        assertTrue(p.protectedSkips().containsKey(ProtectionReason.RECEIVED_AFTER_PLAN_START.key()));
    }

    // ── 保護（正例＋負例: 保護の無い同じ検査は選ばれ、保護を付けると外れる） ──

    @FunctionalInterface
    private interface Protect {
        void apply(String study, String sop, String series) throws Exception;
    }

    private void expectProtected(String label, ProtectionReason reason, Protect protect) throws Exception {
        long old = System.currentTimeMillis() - 60 * DAY;
        String free = ingest("PROT-" + label + "-free", old);   // 保護なし（同じ古さ）
        String guarded = ingest("PROT-" + label, old);
        days(30);
        assertTrue(uids(service.preview()).contains(guarded), label + ": 保護の前は選ばれる");
        protect.apply(guarded, guarded + ".1", guarded + ".s");
        RetentionPlan p = service.preview();
        assertFalse(uids(p).contains(guarded), label + ": 保護で選ばれない");
        assertTrue(uids(p).contains(free), label + ": 保護の無い検査は選ばれる");
        assertTrue(service.protectionsOf().get(guarded).contains(reason), label + ": 理由 " + reason);
        assertTrue(p.protectedSkips().containsKey(reason.key()), label + ": 除外の内訳に出る");
    }

    @Test
    void ロックした検査は消えない() throws Exception {
        expectProtected("lock", ProtectionReason.LOCK, (st, sop, se) -> service.lock(st));
    }

    @Test
    void ROIのある検査は消えない() throws Exception {
        expectProtected("roi", ProtectionReason.ROI, (st, sop, se) -> {
            String key = "PROT-roi";
            rois.save(new RoiDocument(key, "{\"rois\":[{\"sopInstanceUid\":\"" + sop + "\"}],\"analyses\":[]}", 1));
        });
    }

    @Test
    void 解析状態のある検査は消えない() throws Exception {
        expectProtected("analysis", ProtectionReason.ROI, (st, sop, se) ->
                rois.save(new RoiDocument("PROT-analysis", "{\"rois\":[],\"analyses\":[{\"sopInstanceUid\":\"" + sop + "\"}]}", 0)));
    }

    @Test
    void レポートのある検査は消えない() throws Exception {
        expectProtected("report", ProtectionReason.REPORT, (st, sop, se) -> {
            Report r = new Report("rep-" + st);
            r.setStudyInstanceUid(st);
            r.setPatientId("PROT-report");
            reports.save(r);
        });
    }

    @Test
    void 位置合わせのある検査は消えない() throws Exception {
        expectProtected("reg", ProtectionReason.REGISTRATION, (st, sop, se) ->
                registrations.save(new RegistrationDocument("PROT-reg",
                        "{\"records\":[{\"fixed\":{\"seriesInstanceUid\":\"" + se + "\"},\"moving\":{\"seriesInstanceUid\":\"x\"}}]}", 1)));
    }

    @Test
    void GLAM解析のある検査は消えない() throws Exception {
        expectProtected("glam", ProtectionReason.GLAM, (st, sop, se) ->
                glam.save(new GlamAnalysisDocument("g-" + st, st, se, null, "l", "{}", 8, 4, 10L)));
    }

    @Test
    void XA校正のある検査は消えない() throws Exception {
        expectProtected("xa", ProtectionReason.XA_CALIBRATION, (st, sop, se) ->
                settings.putAll(Map.of(SettingsService.XA_CALIBRATION_PREFIX + se, "0.3")));
    }

    @Test
    void プラグインの記録がある患者の検査は消えない() throws Exception {
        expectProtected("plugin", ProtectionReason.PLUGIN_RECORD, (st, sop, se) ->
                plugins.save(new PluginDocument("some-plugin", "PROT-plugin", "{}")));
    }

    @Test
    void 開いている検査は消えない_閉じると外れる() throws Exception {
        expectProtected("inuse", ProtectionReason.IN_USE, (st, sop, se) -> inUse.register(List.of(st)));
    }

    @Test
    void 通常の画像でないDICOMを含む検査は消えない() throws Exception {
        expectProtected("seg", ProtectionReason.NON_IMAGE_DICOM, (st, sop, se) -> {
            DicomInstance r = repo.findById(sop).orElseThrow();
            r.setSopClassUid(UID.SegmentationStorage);
            repo.save(r);
        });
    }

    @Test
    void 線量SRと二次キャプチャは保護の理由にしない() throws Exception {
        long old = System.currentTimeMillis() - 60 * DAY;
        String st = ingest("DOSE", old);
        DicomInstance r = repo.findById(st + ".1").orElseThrow();
        r.setSopClassUid(UID.XRayRadiationDoseSRStorage);
        repo.save(r);
        days(30);
        assertTrue(uids(service.preview()).contains(st), "線量 SR だけの検査は保護しない");
    }

    @Test
    void 受信日時が不明の画像を含む検査は消えない() throws Exception {
        long old = System.currentTimeMillis() - 60 * DAY;
        String st = ingest("UNK", old);
        DicomInstance r = repo.findById(st + ".1").orElseThrow();
        r.setReceivedAt(null);
        repo.save(r);
        days(30);
        assertFalse(uids(service.preview()).contains(st));
    }

    // ── 条件の保存・ロック・参考値 ──

    @Test
    void 条件の保存は検査し_不正な値は保存しない() {
        RetentionConfig ok = service.saveConfig(new RetentionConfig(30, 500.0, 20.0));
        assertEquals(30, ok.days());
        for (RetentionConfig bad : List.of(new RetentionConfig(0, null, null), new RetentionConfig(-3, null, null),
                new RetentionConfig(null, 0.0, null), new RetentionConfig(null, null, -1.0),
                new RetentionConfig(null, Double.NaN, null), new RetentionConfig(null, null, Double.POSITIVE_INFINITY))) {
            assertThrows(IllegalArgumentException.class, () -> service.saveConfig(bad));
        }
        assertEquals(30, service.config().days(), "不正な値で、保存済みの値が変わらない");
        service.saveConfig(new RetentionConfig(null, null, null));
        assertFalse(service.config().any(), "空にすると条件が消える");
        assertNull(settings.getAll().get("retention.days"));
    }

    @Test
    void 保存値が壊れていたら黙って別の意味にせず失敗する() {
        settings.putAll(Map.of("retention.days", "abc"));
        try {
            assertThrows(IllegalArgumentException.class, () -> service.config());
        } finally {
            settings.deleteKeys(List.of("retention.days"));
        }
    }

    @Test
    void ロックの付け外しと一覧_存在しない検査は拒否() throws Exception {
        String st = ingest("LK1", System.currentTimeMillis());
        assertThrows(IllegalArgumentException.class, () -> service.lock("no.such.study"));
        service.lock(st);
        service.lock(st); // 重ねても壊れない
        assertTrue(service.listHolds().stream().anyMatch(h -> h.studyUid().equals(st) && h.studyExists()));
        service.unlock(st);
        assertTrue(service.listHolds().stream().noneMatch(h -> h.studyUid().equals(st)));
    }

    @Test
    void ロックは自動削除だけを止める_手動の削除は変わらない() throws Exception {
        String st = ingest("LK2", System.currentTimeMillis());
        service.lock(st);
        dbAdmin.deleteStudy(st);
        assertEquals(0, repo.countByStudyInstanceUid(st), "手動の削除はロックの影響を受けない");
    }

    @Test
    void API_不正な条件は400で保存されず_試算の前後で何も消えない() throws Exception {
        RetentionController c = new RetentionController(service, inUse);
        service.saveConfig(new RetentionConfig(60, null, null));
        var e = assertThrows(org.springframework.web.server.ResponseStatusException.class,
                () -> c.saveConfig(new RetentionConfig(0, null, null)));
        assertEquals(400, e.getStatusCode().value());
        assertEquals(60, c.config().days(), "不正な値で保存済みの値が変わらない");
        assertEquals(400, assertThrows(org.springframework.web.server.ResponseStatusException.class,
                () -> c.lock("no.such.study")).getStatusCode().value());

        ingest("API1", System.currentTimeMillis() - 400 * DAY);
        long files = filesUnder(tmp.resolve("store"));
        long rows = repo.count();
        RetentionPlan p = c.preview();
        assertFalse(p.items().isEmpty());
        assertEquals(files, filesUnder(tmp.resolve("store")));
        assertEquals(rows, repo.count());
        // 開いている検査の登録・解除（同じ検査を 2 つのウィンドウで開いても、片方を閉じただけでは外れない）
        c.register(Map.of("studyUids", List.of("s.x")));
        c.register(Map.of("studyUids", List.of("s.x")));
        c.release(Map.of("studyUids", List.of("s.x")));
        assertTrue(inUse.snapshot().contains("s.x"));
        c.release(Map.of("studyUids", List.of("s.x")));
        assertFalse(inUse.snapshot().contains("s.x"));
    }

    @Test
    void 参考値は実測から出る() throws Exception {
        ingest("REF1", System.currentTimeMillis());
        org.mockito.Mockito.when(freeSpace.usableBytes()).thenReturn(123L);
        org.mockito.Mockito.when(freeSpace.totalBytes()).thenReturn(456L);
        RetentionService.Status s = service.status();
        assertEquals(123L, s.diskFreeBytes());
        assertEquals(456L, s.diskTotalBytes());
        assertTrue(s.storeBytes() > 0);
        assertTrue(s.largestStudyBytes() > 0 && s.largestStudyBytes() <= s.storeBytes());
        assertNotNull(s.maxDailyIntakeBytes());
        assertTrue(s.recordedDays() >= 1);
    }
}
