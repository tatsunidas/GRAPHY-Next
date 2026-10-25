/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.vis.graphynext.dbadmin.DbAdminService;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageBackend;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.gdrive.StorageChanged;
import com.vis.graphynext.roi.RoiDocument;
import com.vis.graphynext.roi.RoiDocumentRepository;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.when;

/**
 * 自動削除の実行（段 2）。実際の DB と保管庫で、<b>消す・消さない</b>をファイル数と索引の件数で確かめる。
 * 時計と空き容量は差し替える。実行は同じスレッドで直接走らせる。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:retentionrun;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.retention.auto-run=false"
        })
class RetentionRunnerTest {

    private static final long DAY = 24L * 60 * 60 * 1000;
    /** 合成画像 1 枚の大きさは数百バイト。GB 指定の条件には、この大きさに合う極小の値（GB）を使う。 */
    private static final double BYTES = 1.0 / RetentionConfig.GB;

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
    @Autowired RetentionEventRepository events;
    @Autowired RetentionRunRepository runs;
    @Autowired RetentionFirstRunRepository firstRun;
    @Autowired RoiDocumentRepository rois;
    @Autowired SettingsService settings;
    @MockBean FreeSpaceProvider freeSpace;

    private static final AtomicInteger seq = new AtomicInteger();
    private RetentionRunner runner;
    private final List<Runnable> queued = new ArrayList<>();

    @BeforeEach
    void setUp() {
        // 他のテストの状態を持ち越さない（共有の DB）
        service.disable();
        service.saveConfig(new RetentionConfig(null, null, null));
        for (var s : repo.findAll().stream().map(DicomInstance::getStudyInstanceUid).distinct().toList()) {
            dbAdmin.deleteStudy(s);
        }
        events.deleteAll();
        runs.deleteAll();
        holds.deleteAll();
        when(freeSpace.usableBytes()).thenReturn(Long.MAX_VALUE / 4);
        when(freeSpace.totalBytes()).thenReturn(Long.MAX_VALUE / 2);
        runner = new RetentionRunner(service, dbAdmin, holds, inUse, repo, freeSpace, layout, events, runs,
                Clock.systemUTC(), false, Runnable::run);
    }

    @AfterEach
    void tearDown() {
        storage.setClock(Clock.systemUTC());
        layout.setBackend(StorageBackend.NONE);
    }

    private String ingest(String patientId, long daysAgo, int images) throws Exception {
        String n = String.valueOf(seq.incrementAndGet());
        String study = "1.7.7." + n;
        storage.setClock(Clock.fixed(Instant.ofEpochMilli(System.currentTimeMillis() - daysAgo * DAY), ZoneOffset.UTC));
        for (int i = 0; i < images; i++) {
            Attributes ds = DicomPhantomFactory.scImage(patientId, study, study + ".s", study + "." + i);
            ds.setString(Tag.PatientName, VR.PN, "Name^" + n);
            ds.setString(Tag.Modality, VR.CS, "CT");
            storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian));
        }
        return study;
    }

    private String ingest(String patientId, long daysAgo) throws Exception {
        return ingest(patientId, daysAgo, 1);
    }

    private static long files(Path root) throws Exception {
        if (!Files.exists(root)) {
            return 0;
        }
        try (Stream<Path> s = Files.walk(root)) {
            return s.filter(Files::isRegularFile).count();
        }
    }

    private long storeFiles() throws Exception {
        return files(tmp.resolve("store"));
    }

    private boolean exists(String study) {
        return repo.countByStudyInstanceUid(study) > 0;
    }

    /** 試算 → 有効化（画面の流れと同じ）。 */
    private RetentionService.Preview enableWith(RetentionConfig cfg) {
        service.saveConfig(cfg);
        RetentionService.Preview p = service.previewWithId();
        service.enable(p.previewId());
        return p;
    }

    // ── 既定オフ・有効化の歯止め ──

    @Test
    void 有効にしていなければ_どの入口でも1件も消えない() throws Exception {
        String old = ingest("OFF", 400);
        service.saveConfig(new RetentionConfig(30, null, null));
        long files = storeFiles();
        long rows = repo.count();
        runner.runGuarded("daily");
        runner.runGuarded("storage");
        runner.onStorageChanged(new StorageChanged("x"));
        runner.tickDay(LocalDate.now());
        assertEquals("not-enabled", assertThrows(IllegalStateException.class, () -> runner.runNow()).getMessage());
        assertEquals(files, storeFiles());
        assertEquals(rows, repo.count());
        assertTrue(exists(old));
        assertEquals(0, runs.count());
    }

    @Test
    void 有効化は条件か試算が欠けていれば拒否され_何も変わらない() throws Exception {
        ingest("REF", 400);
        assertThrows(IllegalArgumentException.class, () -> service.enable("no-such-id"), "条件が無い");
        service.saveConfig(new RetentionConfig(30, null, null));
        assertThrows(IllegalArgumentException.class, () -> service.enable("no-such-id"), "試算が無い");
        RetentionService.Preview p = service.previewWithId();
        service.saveConfig(new RetentionConfig(10, null, null)); // 試算のあとに条件が変わった
        assertThrows(IllegalArgumentException.class, () -> service.enable(p.previewId()), "条件が試算のときと違う");
        assertFalse(service.isEnabled());
    }

    @Test
    void モードAでは有効にできない() throws Exception {
        ingest("MODEA", 400);
        service.saveConfig(new RetentionConfig(30, null, null));
        RetentionService.Preview p = service.previewWithId();
        layout.setBackend(new StorageBackend() {
            public boolean cacheMode() {
                return true;
            }

            public Path ensureLocal(String relPath) {
                return null;
            }

            public void prefetch(java.util.Collection<String> relPaths, java.util.function.BooleanSupplier cancelled) {
            }

            public void touch(String relPath) {
            }
        });
        assertEquals("cache-mode-unsupported", assertThrows(IllegalStateException.class, () -> service.enable(p.previewId())).getMessage());
        assertFalse(service.isEnabled());
    }

    @Test
    void 汎用の設定APIで有効の印を書いても_条件を書き換えても_有効にならない() throws Exception {
        String old = ingest("BYPASS", 400);
        service.saveConfig(new RetentionConfig(30, null, null));
        settings.putAll(Map.of("retention.enabled", "true")); // 試算を通さずに書いた
        assertFalse(service.isEnabled());
        runner.runGuarded("daily");
        assertTrue(exists(old));

        enableWith(new RetentionConfig(30, null, null));
        assertTrue(service.isEnabled());
        settings.putAll(Map.of("retention.days", "1")); // 条件を、このクラスを通さずに変えた
        assertFalse(service.isEnabled(), "指紋が合わなくなり無効に戻る");
    }

    @Test
    void 条件の保存は有効を外す() throws Exception {
        ingest("SAVEOFF", 400);
        enableWith(new RetentionConfig(30, null, null));
        assertTrue(service.isEnabled());
        service.saveConfig(new RetentionConfig(30, null, null));
        assertFalse(service.isEnabled());
        assertEquals(0, firstRun.count());
    }

    // ── 日数・容量 ──

    @Test
    void 日数_31日前は消え29日前は残る_ファイルも索引も_記録に残る() throws Exception {
        String old = ingest("D31", 31, 2);
        String recent = ingest("D29", 29);
        long filesBefore = storeFiles();
        enableWith(new RetentionConfig(30, null, null));

        RetentionRun run = runner.runNow();
        assertNotNull(run);
        assertFalse(exists(old), "索引から無い");
        assertTrue(exists(recent));
        assertEquals(filesBefore - 2, storeFiles(), "ファイルも 2 枚消えた");
        assertEquals(1, run.getDeleted());
        List<RetentionEvent> ev = events.findByRunId(run.getId());
        assertEquals(1, ev.size());
        assertEquals("deleted", ev.get(0).getResult());
        assertEquals(old, ev.get(0).getStudyUid());
        assertEquals("days", ev.get(0).getReason());
        // 知らせ: 見ていない実行があり、見たことにすると消える
        assertNotNull(service.notice());
        service.ackNotice();
        assertNull(service.notice());
    }

    @Test
    void 空きの下限_古い順に下限以上になったところで止まる() throws Exception {
        String a = ingest("FA", 30);
        String b = ingest("FB", 20);
        String c = ingest("FC", 10);
        long size = repo.findByStudyInstanceUid(a).get(0).getSizeBytes();
        long total = repo.totalSizeBytes();
        // 空き = 基準 0 ＋ 消した分。下限は「画像 1.5 枚ぶん」→ 2 枚消すと満たす（3 枚目は消さない）
        when(freeSpace.usableBytes()).thenAnswer(i -> total - repo.totalSizeBytes());
        enableWith(new RetentionConfig(null, null, (size * 1.5) * BYTES));
        RetentionRun run = runner.runNow();
        assertFalse(exists(a));
        assertFalse(exists(b));
        assertTrue(exists(c), "条件を満たしたところで止まる");
        assertEquals(2, run.getDeleted());
        assertTrue(run.isSatisfied());
    }

    @Test
    void 保管庫の上限_合計が上限以下になったところで止まる() throws Exception {
        String a = ingest("MA", 30);
        String b = ingest("MB", 20);
        String c = ingest("MC", 10);
        long size = repo.findByStudyInstanceUid(a).get(0).getSizeBytes();
        enableWith(new RetentionConfig(null, (size * 1.5) * BYTES, null)); // 画像 1.5 枚ぶんまで
        runner.runNow();
        assertFalse(exists(a));
        assertFalse(exists(b));
        assertTrue(exists(c));
    }

    // ── 最初の 1 回・保護 ──

    @Test
    void 最初の1回は試算で見た検査だけ_2回目から自動() throws Exception {
        String seen = ingest("FR1", 100);
        enableWith(new RetentionConfig(30, null, null));
        String later = ingest("FR2", 100); // 試算のあとに入った古い検査
        assertEquals(1, firstRun.count());
        runner.runNow();
        assertFalse(exists(seen));
        assertTrue(exists(later), "試算で見せていない検査は 1 回目では消さない");
        assertEquals(0, firstRun.count(), "1 回目が終わったら空");
        runner.runNow();
        assertFalse(exists(later), "2 回目からは条件どおり");
    }

    @Test
    void 最初の1回の対象がすべて保護中なら_使い切らず_見せていない検査も消さない() throws Exception {
        String seen = ingest("FP1", 100);
        enableWith(new RetentionConfig(30, null, null));
        String later = ingest("FP2", 100); // 試算のあとに入った古い検査（見せていない）
        service.lock(seen);
        runner.runNow();
        runner.runNow();
        assertTrue(exists(seen), "ロック中は消えない");
        assertTrue(exists(later), "見せていない検査は、対象が保護中の間も消さない");
        assertEquals(1, firstRun.count(), "保護中の対象は最初の 1 回として残る");
        service.unlock(seen);
        runner.runNow();
        assertFalse(exists(seen), "保護が外れたら、見せた検査として消える");
        assertTrue(exists(later), "その実行でも見せていない検査は消さない");
        assertEquals(0, firstRun.count());
        runner.runNow();
        assertFalse(exists(later), "そのあとは条件どおり");
    }

    @Test
    void 最初の1回の対象の一部だけ保護中なら_ほかは消え_保護分だけ残る() throws Exception {
        String a = ingest("FQ1", 100);
        String b = ingest("FQ2", 100);
        enableWith(new RetentionConfig(30, null, null));
        service.lock(a);
        runner.runNow();
        assertTrue(exists(a));
        assertFalse(exists(b));
        assertEquals(1, firstRun.count());
    }

    @Test
    void 最初の1回の対象が索引から無くなったら_制限は残らず_2回目から自動() throws Exception {
        String seen = ingest("FR3", 100);
        enableWith(new RetentionConfig(30, null, null));
        String later = ingest("FR4", 100);
        dbAdmin.deleteStudy(seen); // 手動で消えた
        runner.runNow();
        assertEquals(0, firstRun.count(), "決着した対象は残さない");
        assertTrue(exists(later), "この実行は最初の 1 回の扱い（見せていない検査は消さない）");
        runner.runNow();
        assertFalse(exists(later), "2 回目からは条件どおり");
    }

    @Test
    void ロックした検査と開いている検査は_計画の時点で外れて消えない() throws Exception {
        String locked = ingest("RL", 100);
        String open = ingest("RO", 100);
        String plain = ingest("RP", 100);
        service.saveConfig(new RetentionConfig(30, null, null));
        service.lock(locked);
        inUse.register(List.of(open));
        try {
            service.enable(service.previewWithId().previewId());
            runner.runNow();
            assertTrue(exists(locked));
            assertTrue(exists(open));
            assertFalse(exists(plain));
        } finally {
            inUse.release(List.of(open));
        }
    }

    @Test
    void 実行直前の再確認_計画のあとにロックされた検査や開かれた検査は消さない() throws Exception {
        String locked = ingest("RL2", 100);
        String open = ingest("RO2", 100);
        String plain = ingest("RP2", 100);
        enableWith(new RetentionConfig(30, null, null)); // 3 件とも計画に入る
        // 計画を立てたあと、1 件ずつ消す直前に状態が変わる（ロックされる・ビューアで開かれる）
        runner.setBeforeEach(uid -> {
            if (uid.equals(locked)) {
                service.lock(uid);
            }
            if (uid.equals(open)) {
                inUse.register(List.of(uid));
            }
        });
        try {
            RetentionRun run = runner.runNow();
            assertTrue(exists(locked), "計画のあとにロックされた検査は消さない");
            assertTrue(exists(open), "計画のあとに開かれた検査は消さない");
            assertFalse(exists(plain));
            assertEquals(2, run.getSkipped());
            var reasons = events.findByRunId(run.getId()).stream().filter(e -> "skipped".equals(e.getResult()))
                    .map(RetentionEvent::getErrorKind).toList();
            assertTrue(reasons.contains("lock") && reasons.contains("inUse"), reasons.toString());
        } finally {
            inUse.release(List.of(open));
        }
    }

    @Test
    void 再確認の関数_ロック_開いている_判定開始後の受信_不明_消えた検査() throws Exception {
        String st = ingest("RC", 5);
        long last = repo.studyRetentionRowOf(st).get(0).getLastReceivedAt();
        assertNull(runner.recheck(st, last + 1), "判定の開始より前に受信した検査は通る");
        assertEquals("receivedAfterPlanStart", runner.recheck(st, last), "判定の開始と同時か後に受信した検査は除く");
        assertEquals("receivedAfterPlanStart", runner.recheck(st, last - 1));
        assertEquals("gone", runner.recheck("no.such.study", last));
        service.lock(st);
        assertEquals("lock", runner.recheck(st, last + 1));
        service.unlock(st);
        inUse.register(List.of(st));
        assertEquals("inUse", runner.recheck(st, last + 1));
        inUse.release(List.of(st));
        DicomInstance r = repo.findByStudyInstanceUid(st).get(0);
        r.setReceivedAt(null);
        repo.save(r);
        assertEquals("unknownReceived", runner.recheck(st, last + 1));
    }

    // ── 失敗 ──

    @Test
    void 一部の画像を消せなければ_その行は索引に残り_次の実行で消える() throws Exception {
        String st = ingest("PART", 100, 2);
        DicomInstance bad = repo.findByStudyInstanceUid(st).get(1);
        Path dir = tmp.resolve("store").resolve("bad-dir");
        Files.createDirectories(dir);
        Path inside = Files.writeString(dir.resolve("keep.txt"), "x");
        bad.setUri("bad-dir"); // 中身のあるフォルダ → ファイルとして消せない（OS 非依存・やり直しで直らない）
        repo.save(bad);
        enableWith(new RetentionConfig(30, null, null));

        RetentionRun run = runner.runNow();
        assertEquals(1, run.getPartial());
        assertEquals(1, repo.countByStudyInstanceUid(st), "消せなかった行は索引に残る（一覧から見える）");
        assertFalse(run.isSatisfied());
        assertEquals("partial", events.findByRunId(run.getId()).get(0).getResult());
        assertEquals(1, events.findByRunId(run.getId()).get(0).getFailedFiles());

        Files.delete(inside);
        Files.delete(dir);
        RetentionRun second = runner.runNow();
        assertEquals(1, second.getDeleted());
        assertFalse(exists(st), "次の実行でもう一度消そうとして消えた");
    }

    @Test
    void 消えた画像の付随データは片付くが_保護される検査は消えない() throws Exception {
        String st = ingest("REL", 100);
        rois.save(new RoiDocument("REL", "{\"rois\":[],\"analyses\":[]}", 0)); // 画像に結び付かない空の文書
        enableWith(new RetentionConfig(30, null, null));
        runner.runNow();
        assertFalse(exists(st));
        assertTrue(rois.findById("REL").isEmpty(), "患者の画像が無くなったので ROI 文書も片付く");
    }

    // ── 入口 ──

    @Test
    void 受信の入口は_条件内なら計画も立てず_割ったときだけ実行する() throws Exception {
        String a = ingest("GA", 30);
        String b = ingest("GB", 20);
        long size = repo.findByStudyInstanceUid(a).get(0).getSizeBytes();
        enableWith(new RetentionConfig(null, null, size * 0.5 * BYTES)); // 空きの下限
        when(freeSpace.usableBytes()).thenReturn(size * 10L); // 下限以上
        runner.runGuarded("storage");
        assertEquals(0, runs.count(), "条件内なら実行の記録も作らない");
        assertTrue(exists(a) && exists(b));

        when(freeSpace.usableBytes()).thenAnswer(i -> 0L); // 下限を割った
        runner.runGuarded("storage");
        assertTrue(runs.count() >= 1);
        assertFalse(exists(a), "割ったら古い順に消す");
    }

    @Test
    void 日数だけの条件は_受信の入口では動かず_日付の変わり目で動く() throws Exception {
        String old = ingest("DAYONLY", 100);
        enableWith(new RetentionConfig(30, null, null));
        runner.runGuarded("storage");
        assertTrue(exists(old));
        runner.runGuarded("daily");
        assertFalse(exists(old));
    }

    @Test
    void 要求は畳まれる_同じ日の再判定は要求しない() throws Exception {
        List<Runnable> q = new ArrayList<>();
        Executor collect = q::add;
        RetentionRunner r = new RetentionRunner(service, dbAdmin, holds, inUse, repo, freeSpace, layout, events, runs,
                Clock.systemUTC(), false, collect);
        r.onStorageChanged(new StorageChanged("a"));
        r.onStorageChanged(new StorageChanged("b"));
        r.onStorageChanged(new StorageChanged("c"));
        assertEquals(1, q.size(), "待機中の要求は 1 つに畳まれる");
        q.remove(0).run();
        r.onStorageChanged(new StorageChanged("d"));
        assertEquals(1, q.size(), "走ったあとの新しい要求は受け付ける");
        q.remove(0).run();
        LocalDate d = LocalDate.of(2026, 10, 25);
        r.tickDay(d);
        r.tickDay(d);
        assertEquals(1, q.size(), "同じ日は 1 回だけ");
        q.remove(0).run();
        r.tickDay(d.plusDays(1));
        assertEquals(1, q.size(), "日付が変わったらまた要求する");
    }

    // ── ログ ──

    @Test
    void ログに患者名が出ない() throws Exception {
        String st = ingest("LOGP", 100);
        String name = repo.findByStudyInstanceUid(st).get(0).getPatientName();
        ListAppender<ILoggingEvent> app = new ListAppender<>();
        app.start();
        Logger l1 = (Logger) LoggerFactory.getLogger(RetentionRunner.class);
        Logger l2 = (Logger) LoggerFactory.getLogger(DbAdminService.class);
        l1.addAppender(app);
        l2.addAppender(app);
        l1.setLevel(Level.DEBUG);
        try {
            enableWith(new RetentionConfig(30, null, null));
            runner.runNow();
        } finally {
            l1.detachAppender(app);
            l2.detachAppender(app);
        }
        assertFalse(app.list.isEmpty(), "実行のログが出ている");
        for (ILoggingEvent e : app.list) {
            assertFalse(e.getFormattedMessage().contains(name), "ログに患者名: " + e.getFormattedMessage());
        }
    }
}
