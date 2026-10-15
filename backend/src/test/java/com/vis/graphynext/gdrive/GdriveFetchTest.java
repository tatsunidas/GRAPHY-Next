/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.store.StorageUnavailableException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * モード A の「手元に無ければ Drive から取り寄せる」（P2-2）。
 * 守ること: 取り寄せた内容は md5・サイズが台帳と一致する／取り寄せたあとに送り直さない（mtime を台帳に戻す）／
 * 失敗は null でなく例外（「その画像は無い」と取り違えさせない）／同じファイルへの同時要求は 1 回だけ取得／壊れた内容を置かない。
 */
@DataJpaTest(properties = {"spring.jpa.hibernate.ddl-auto=create-drop"})
// 取り寄せは cycle() とは別のスレッド（読み出し・先読みの並列）から台帳を引く。テストの取引の中に閉じると他スレッドから見えないので、
// 各呼び出しを実際にコミットさせ、テストごとに台帳を空にする
@org.springframework.transaction.annotation.Transactional(propagation = org.springframework.transaction.annotation.Propagation.NOT_SUPPORTED)
class GdriveFetchTest {

    static final String FOLDER = "GRAPHYfolder0001";
    static final int SIZE = 100_000;
    static final String A = "1.1/2.1/3.1.dcm";
    static final String B = "1.1/2.1/3.2.dcm";
    static final String C = "1.1/2.1/3.3.dcm";

    @Autowired
    GdriveSyncRepository repo;

    @TempDir
    Path root;

    FakeDrive drive;
    GdriveSyncService svc;
    long now = 1_000_000L;
    final Clock clock = new Clock() {
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId z) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(now); }
        @Override public long millis() { return now; }
    };
    final byte[][] data = new byte[3][];

    @BeforeEach
    void setUp() throws IOException {
        repo.deleteAll();
        drive = new FakeDrive();
        FakeDrive.File f = new FakeDrive.File();
        f.id = FOLDER;
        f.name = "GRAPHY-DB-t";
        f.folder = true;
        drive.files.put(FOLDER, f);
        svc = new GdriveSyncService(repo, root, drive.base(), drive.tokenUrl(), clock, () -> 0.5, 30_000, 600_000, false,
                GdriveSyncServiceTest::fakeBackup, 600_000, 3_600_000, 3);
        cache(250_000);
        // A, B, C を 11 分ずつ空けて同期 → 上限 250KB なので A が追い出される
        String[] rels = {A, B, C};
        for (int i = 0; i < 3; i++) {
            data[i] = new byte[SIZE];
            new Random(100 + i).nextBytes(data[i]);
            Path p = root.resolve(rels[i]);
            Files.createDirectories(p.getParent());
            Files.write(p, data[i]);
            svc.onStorageChanged(new StorageChanged(rels[i]));
            svc.cycle();
            now += 11 * 60_000;
        }
        svc.cycle();
        assertTrue(repo.findById(A).orElseThrow().isEvicted(), "前提: A は追い出されている");
        assertFalse(Files.exists(root.resolve(A)), "前提: A は手元に無い");
    }

    @AfterEach
    void tearDown() {
        drive.close();
        repo.deleteAll();
    }

    private void cache(long limit) {
        svc.configure(new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", "dev-AAAA-0001", "hostA", true, limit));
    }

    private static String md5(byte[] b) {
        return FakeDrive.md5(b);
    }

    // ── 正例 ──

    @Test
    void 追い出された検査を取り寄せ_内容が一致し_台帳が手元ありに戻る() throws Exception {
        Path p = svc.ensureLocal(A);
        assertEquals(root.resolve(A), p);
        assertEquals(md5(data[0]), md5(Files.readAllBytes(p)));
        GdriveSyncItem row = repo.findById(A).orElseThrow();
        assertFalse(row.isEvicted());
        assertEquals(row.getMtime(), Files.getLastModifiedTime(p).toMillis(), "mtime は台帳の値（同期したときのもの）に戻る");
        assertEquals(SIZE, Files.size(p));
        assertTrue(row.getLastAccessAt() >= now - 1);
        try (var s = Files.list(p.getParent())) {
            assertEquals(0, s.filter(f -> f.getFileName().toString().startsWith(".")).count(), "一時ファイルが残らない");
        }
    }

    @Test
    void 取り寄せたあと_全走査しても送り直さず_Drive_も変わらない() throws Exception {
        svc.ensureLocal(A);
        long uploads = drive.dcmStarts();
        cache(10_000_000); // 取り寄せ直後に追い出し直されないよう上限を広げる
        svc.syncNow();
        svc.cycle();
        assertEquals(uploads, drive.dcmStarts(), "取り寄せただけで再アップロードしない");
        assertEquals(3, drive.liveCount());
        assertEquals(GdriveSyncItem.SYNCED, repo.findById(A).orElseThrow().getState());
        assertEquals(0, drive.files.values().stream().filter(f -> f.trashed && f.name.endsWith(".dcm")).count(),
                "画像はゴミ箱へ送られない（ロックの付け替えで出るロックファイルは別）");
    }

    @Test
    void 手元に有るもの_台帳に無いものは取り寄せず_そのまま扱う() throws Exception {
        assertEquals(root.resolve(C), svc.ensureLocal(C));
        assertNull(svc.ensureLocal("9.9/9.9/9.9.dcm"), "知らないファイルは null（従来どおり「無い」）");
        assertNull(svc.ensureLocal("../escape.dcm"), "保管庫の外は触らない");
    }

    @Test
    void 同じファイルへの同時要求は_1回だけ取得する() throws Exception {
        long before = drive.log.stream().filter(l -> l.startsWith("GET /drive/v3/files/")).count();
        ExecutorService pool = Executors.newFixedThreadPool(6);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Path>> fs = new java.util.ArrayList<>();
        for (int i = 0; i < 6; i++) {
            fs.add(pool.submit(() -> {
                go.await();
                return svc.ensureLocal(A);
            }));
        }
        go.countDown();
        for (Future<Path> f : fs) {
            assertEquals(root.resolve(A), f.get());
        }
        pool.shutdown();
        long gets = drive.log.stream().filter(l -> l.startsWith("GET /drive/v3/files/")).count() - before;
        assertEquals(1, gets, "取得の GET は 1 回だけ（同時要求を束ねる）");
        assertEquals(md5(data[0]), md5(Files.readAllBytes(root.resolve(A))));
    }

    @Test
    void 先読みは複数を並列に取り寄せる() throws Exception {
        cache(10_000_000);
        svc.cycle();
        // B・C も追い出した状態を作る
        cache(150_000);
        now += 11 * 60_000;
        svc.cycle();
        assertTrue(repo.findById(B).orElseThrow().isEvicted());
        cache(10_000_000);
        svc.prefetch(List.of(A, B), () -> false);
        assertTrue(Files.exists(root.resolve(A)) && Files.exists(root.resolve(B)));
        assertEquals(md5(data[1]), md5(Files.readAllBytes(root.resolve(B))));
    }

    // ── 負例 ──

    @Test
    void 取得中に中身が化けたら置かず_例外にし_追い出し済みのまま() throws Exception {
        drive.corruptDownloads = true;
        StorageUnavailableException e = assertThrows(StorageUnavailableException.class, () -> svc.ensureLocal(A));
        assertEquals(StorageUnavailableException.MD5_MISMATCH, e.reason());
        assertFalse(Files.exists(root.resolve(A)), "壊れた内容を画像として置かない");
        try (var s = Files.list(root.resolve("1.1/2.1"))) {
            assertEquals(0, s.filter(f -> f.getFileName().toString().startsWith(".")).count(), "一時ファイルも残さない");
        }
        assertTrue(repo.findById(A).orElseThrow().isEvicted());
        drive.corruptDownloads = false;
        assertEquals(root.resolve(A), svc.ensureLocal(A), "直ったら取れる");
    }

    @Test
    void ネットが切れていたら_null_でなく_offline_の例外() throws Exception {
        // JDK の HttpClient は閉じた接続の GET を 1 回だけ自動でやり直すので、2 回続けて切る
        for (int i = 0; i < 2; i++) {
            drive.faults.add((m, path, ex) -> m.equals("GET") && path.startsWith("/drive/v3/files/") ? -1 : null);
        }
        StorageUnavailableException e = assertThrows(StorageUnavailableException.class, () -> svc.ensureLocal(A));
        assertEquals(StorageUnavailableException.OFFLINE, e.reason());
        assertFalse(Files.exists(root.resolve(A)));
        assertTrue(repo.findById(A).orElseThrow().isEvicted());
    }

    @Test
    void Drive_側から無くなっていたら_not_on_drive() {
        String id = repo.findById(A).orElseThrow().getDriveFileId();
        drive.files.get(id).trashed = true;
        StorageUnavailableException e = assertThrows(StorageUnavailableException.class, () -> svc.ensureLocal(A));
        assertEquals(StorageUnavailableException.NOT_ON_DRIVE, e.reason());
    }

    @Test
    void 連携を外したあとの要求は_drive_disabled() {
        svc.configure(null);
        StorageUnavailableException e = assertThrows(StorageUnavailableException.class, () -> svc.ensureLocal(A));
        assertEquals(StorageUnavailableException.DISABLED, e.reason());
    }

    @Test
    void 照合できない行は置かない() {
        GdriveSyncItem row = repo.findById(A).orElseThrow();
        row.setMd5(null);
        repo.save(row);
        StorageUnavailableException e = assertThrows(StorageUnavailableException.class, () -> svc.ensureLocal(A));
        assertEquals(StorageUnavailableException.NO_CHECKSUM, e.reason());
        assertFalse(Files.exists(root.resolve(A)));
    }

    @Test
    void 先読みは1件でも失敗したら例外にする() {
        String id = repo.findById(A).orElseThrow().getDriveFileId();
        drive.files.get(id).trashed = true;
        assertThrows(StorageUnavailableException.class, () -> svc.prefetch(List.of(A, C), () -> false));
    }

    @Test
    void 取り消されたら取り寄せない() throws Exception {
        svc.prefetch(List.of(A), () -> true);
        assertFalse(Files.exists(root.resolve(A)));
    }

    // ── StorageLayout（読み出しの入口）との結び付き ──

    private DicomInstance inst(String rel) {
        DicomInstance i = new DicomInstance("sop-" + rel);
        i.setUri(rel);
        return i;
    }

    @Test
    void resolveForRead_は追い出し済みを取り寄せて返し_台帳に無ければ_null() throws Exception {
        StorageLayout layout = new StorageLayout(root);
        layout.setBackend(svc);
        Path p = layout.resolveForRead(inst(A));
        assertEquals(root.resolve(A), p);
        assertEquals(md5(data[0]), md5(Files.readAllBytes(p)));
        assertNull(layout.resolveForRead(inst("7.7/7.7/7.7.dcm")), "台帳に無い・手元にも無い → 従来どおり null");
    }

    @Test
    void resolveForRead_は読んだことを記録し_追い出しの順を変える() throws Exception {
        StorageLayout layout = new StorageLayout(root);
        layout.setBackend(svc);
        cache(10_000_000);
        svc.cycle();
        assertNotNull2(layout.resolveForRead(inst(B))); // B を読んだ（手元にあるものの touch）
        now += 11 * 60_000;
        cache(150_000); // 手元は B と C（A は追い出し済み）。上限を超えるのでどちらか 1 つが追い出される
        svc.cycle();
        // C は B より新しく同期されたが、B が読まれた分だけ B のほうが新しい扱いになる
        assertTrue(Files.exists(root.resolve(B)), "読まれた B は残る");
        assertFalse(Files.exists(root.resolve(C)), "読まれていない C が追い出される");
    }

    @Test
    void resolveForRead_は取得に失敗したら例外で_null_にしない() {
        StorageLayout layout = new StorageLayout(root);
        layout.setBackend(svc);
        drive.corruptDownloads = true;
        assertThrows(StorageUnavailableException.class, () -> layout.resolveForRead(inst(A)));
    }

    @Test
    void prefetch_モードBでは何もしない() {
        StorageLayout layout = new StorageLayout(root); // backend は NONE
        layout.prefetch(List.of(inst(A)), () -> false);
        assertFalse(Files.exists(root.resolve(A)));
        assertNull(layout.resolveForRead(inst(A)));
    }

    private static void assertNotNull2(Object o) {
        org.junit.jupiter.api.Assertions.assertNotNull(o);
    }
}
