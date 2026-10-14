/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

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
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 偽の Drive を相手に、同期の正例と負例を確かめる。ローカルのファイルは一度も変わらないことも見る。 */
@DataJpaTest(properties = {"spring.jpa.hibernate.ddl-auto=create-drop"})
class GdriveSyncServiceTest {

    static final String FOLDER = "GRAPHYfolder0001";

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

    @BeforeEach
    void setUp() throws IOException {
        drive = new FakeDrive();
        drive.files.put(FOLDER, folder(FOLDER));
        svc = new GdriveSyncService(repo, root, drive.base(), drive.tokenUrl(), clock, () -> 0.5, 30_000, 600_000, false, GdriveSyncServiceTest::fakeBackup, 600_000, 3_600_000, 3);
        svc.configure(cfg(FOLDER));
    }

    @AfterEach
    void tearDown() {
        drive.close();
    }

    static GdriveConfig cfg(String folder) {
        return new GdriveConfig("cid", "csecret", "rtoken-SECRET", folder, null, "t", "dev-AAAA-0001", "hostA");
    }

    /** 索引スナップショットの代わり（H2 の実物は別のテストで確かめる）。 */
    static void fakeBackup(Path zip) throws IOException {
        try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(Files.newOutputStream(zip))) {
            z.putNextEntry(new java.util.zip.ZipEntry("graphy-index.mv.db"));
            z.write("INDEX-V1".getBytes());
            z.closeEntry();
        }
    }

    private static FakeDrive.File folder(String id) {
        FakeDrive.File f = new FakeDrive.File();
        f.id = id;
        f.name = "GRAPHY-DB-t";
        f.folder = true;
        return f;
    }

    private Path put(String rel, byte[] data) throws IOException {
        Path p = root.resolve(rel);
        Files.createDirectories(p.getParent());
        Files.write(p, data);
        return p;
    }

    private static byte[] rnd(int n, long seed) {
        byte[] b = new byte[n];
        new Random(seed).nextBytes(b);
        return b;
    }

    private void advance(long ms) {
        now += ms;
    }

    // ── 正例 ──

    @Test
    void 新規ファイルを送り_md5が一致し_ローカルは変わらない() throws Exception {
        byte[] data = rnd(300_000, 1);
        Path p = put("1.2/3.4/5.6.dcm", data);
        long mtime = Files.getLastModifiedTime(p).toMillis();
        svc.cycle();
        assertEquals(1, drive.live("1.2~3.4~5.6.dcm").size());
        assertEquals(FakeDrive.md5(data), FakeDrive.md5(drive.live("1.2~3.4~5.6.dcm").get(0).bytes));
        GdriveSyncService.Status s = svc.status();
        assertEquals(GdriveSyncService.State.CONNECTED, s.state());
        assertEquals(1, s.synced());
        assertEquals(0, s.pending());
        assertTrue(Files.exists(p));
        assertEquals(mtime, Files.getLastModifiedTime(p).toMillis());
        assertEquals(FakeDrive.md5(data), FakeDrive.md5(Files.readAllBytes(p)));
    }

    @Test
    void 同期済みの再実行は何も送らない() throws Exception {
        put("a/b/c.dcm", rnd(1000, 2));
        svc.cycle();
        long uploads = drive.dcmStarts();
        svc.syncNow();
        svc.cycle();
        assertEquals(uploads, drive.dcmStarts());
        assertEquals(1, drive.liveCount());
    }

    @Test
    void 台帳を失っても_Drive_の同じファイルを取り込み_重複しない() throws Exception {
        put("a/b/c.dcm", rnd(1000, 3));
        svc.cycle();
        repo.deleteAll();
        repo.flush();
        svc.configure(cfg(FOLDER));
        svc.cycle();
        assertEquals(1, drive.liveCount(), "二重に作らない");
        assertEquals(1, svc.status().synced());
    }

    @Test
    void 内容が変わったら同じ_Drive_ファイルを更新する() throws Exception {
        Path p = put("a/b/c.dcm", rnd(1000, 4));
        svc.cycle();
        String id = drive.live("a~b~c.dcm").get(0).id;
        byte[] v2 = rnd(1500, 5);
        Files.write(p, v2);
        Files.setLastModifiedTime(p, java.nio.file.attribute.FileTime.fromMillis(Files.getLastModifiedTime(p).toMillis() + 5000));
        svc.syncNow();
        svc.cycle();
        assertEquals(1, drive.liveCount());
        assertEquals(id, drive.live("a~b~c.dcm").get(0).id, "新規作成でなく更新");
        assertEquals(FakeDrive.md5(v2), FakeDrive.md5(drive.live("a~b~c.dcm").get(0).bytes));
    }

    @Test
    void ローカルで消したらゴミ箱へ移し_完全削除はしない() throws Exception {
        Path p = put("a/b/c.dcm", rnd(1000, 6));
        svc.cycle();
        String id = drive.live("a~b~c.dcm").get(0).id;
        Files.delete(p);
        svc.syncNow();
        svc.cycle();
        assertEquals(0, drive.liveCount());
        assertTrue(drive.files.get(id).trashed, "ゴミ箱に在る（消えていない）");
        assertEquals(0, repo.count());
    }

    @Test
    void 除外対象は送らない() throws Exception {
        put("incoming/x.dcm", rnd(100, 7));
        put(".import/y.dcm", rnd(100, 8));
        put(".cache/z.dcm", rnd(100, 9));
        put("a/b/.c.dcm.bak-1234", rnd(100, 10));
        put("a/b/real.dcm", rnd(100, 11));
        svc.cycle();
        assertEquals(1, drive.liveCount());
        assertEquals(1, drive.live("a~b~real.dcm").size());
    }

    @Test
    void 取り込みの合図で次の周期を待たず台帳に載る() throws Exception {
        svc.cycle(); // 最初の reconcile を済ませる
        put("a/b/c.dcm", rnd(100, 12));
        svc.onStorageChanged(new StorageChanged("a/b/c.dcm"));
        svc.cycle();
        assertEquals(1, drive.liveCount());
    }

    // ── 負例・障害 ──

    @Test
    void 接続断では全件を叩かず_復帰後に残件が空になる() throws Exception {
        for (int i = 0; i < 5; i++) {
            put("a/b/f" + i + ".dcm", rnd(100, 20 + i));
        }
        drive.faults.add((m, path, ex) -> drive.dcmStart(path) ? -1 : null);
        svc.cycle();
        assertEquals(GdriveSyncService.State.OFFLINE, svc.status().state());
        assertEquals(0, drive.liveCount());
        assertEquals(1, drive.dcmStarts(), "つながらないのに全件叩かない");
        assertEquals(5, svc.status().pending());
        advance(60_000);
        svc.cycle();
        assertEquals(5, drive.liveCount());
        assertEquals(0, svc.status().pending());
        assertEquals(GdriveSyncService.State.CONNECTED, svc.status().state());
    }

    @Test
    void 大きいファイルの途中で切れたら_受け取り済みの位置から再開する() throws Exception {
        byte[] data = rnd(DriveClient.CHUNK + 1_000_000, 30);
        put("a/b/big.dcm", data);
        // 2 回目のチャンク（最後の 1MB）の PUT で切る
        java.util.concurrent.atomic.AtomicInteger puts = new java.util.concurrent.atomic.AtomicInteger();
        drive.faults.add((m, path, ex) -> m.equals("PUT") && drive.dcmSession(path) && puts.incrementAndGet() == 2 ? -1 : null);
        svc.cycle();
        assertEquals(0, drive.liveCount(), "途中では完了していない");
        long first = drive.bytesReceived;
        assertEquals(DriveClient.CHUNK, first);
        advance(60_000);
        svc.cycle();
        assertEquals(1, drive.liveCount());
        assertEquals(FakeDrive.md5(data), FakeDrive.md5(drive.live("a~b~big.dcm").get(0).bytes));
        assertEquals(data.length, drive.bytesReceived, "最初から送り直さず、続きだけを送った");
        assertEquals(0, drive.wasted, "受け取り済みの位置より前を送り直していない");
    }

    @Test
    void 一時的なエラー_429と503_は再試行し_待ち時間が延びる() throws Exception {
        put("a/b/c.dcm", rnd(100, 40));
        drive.faults.add((m, path, ex) -> drive.dcmStart(path) ? 429 : null);
        svc.cycle();
        assertEquals(1, repo.findAll().get(0).getAttempts());
        long first = repo.findAll().get(0).getNextAttemptAt() - now;
        drive.faults.add((m, path, ex) -> drive.dcmStart(path) ? 503 : null);
        advance(first + 1);
        svc.cycle();
        long second = repo.findAll().get(0).getNextAttemptAt() - now;
        assertEquals(2, repo.findAll().get(0).getAttempts());
        assertTrue(second > first, "指数的に延びる: " + first + " → " + second);
        advance(second + 1);
        svc.cycle();
        assertEquals(1, drive.liveCount());
    }

    @Test
    void 時間が来るまで再試行しない() throws Exception {
        put("a/b/c.dcm", rnd(100, 41));
        drive.faults.add((m, path, ex) -> drive.dcmStart(path) ? 503 : null);
        svc.cycle();
        long calls = drive.dcmStarts();
        svc.cycle();
        assertEquals(calls, drive.dcmStarts());
    }

    @Test
    void 認証が401ならトークンを取り直して1回だけやり直す() throws Exception {
        put("a/b/c.dcm", rnd(100, 42));
        java.util.concurrent.atomic.AtomicInteger n = new java.util.concurrent.atomic.AtomicInteger();
        drive.faults.add((m, path, ex) -> drive.dcmStart(path) && n.getAndIncrement() == 0 ? 401 : null);
        svc.cycle();
        assertEquals(1, drive.liveCount());
        assertTrue(drive.tokenCalls.get() >= 2, "取り直した");
    }

    @Test
    void invalid_grant_なら要再ログインで止まり_叩き続けない() throws Exception {
        put("a/b/c.dcm", rnd(100, 43));
        drive.tokenError = "invalid_grant";
        svc.cycle();
        assertEquals(GdriveSyncService.State.NEEDS_LOGIN, svc.status().state());
        assertEquals(0, drive.liveCount());
        int calls = drive.tokenCalls.get();
        assertTrue(calls <= 2);
    }

    @Test
    void 容量超過は要対応で止まり_無限に叩かない() throws Exception {
        for (int i = 0; i < 4; i++) {
            put("a/b/f" + i + ".dcm", rnd(100, 50 + i));
        }
        drive.reason403 = "storageQuotaExceeded";
        drive.faults.add((m, path, ex) -> drive.dcmStart(path) ? 403 : null);
        svc.cycle();
        assertEquals(GdriveSyncService.State.NEEDS_ATTENTION, svc.status().state());
        assertEquals("quota", svc.status().reason());
        assertEquals(1, drive.dcmStarts());
        assertEquals(4, svc.status().pending());
    }

    @Test
    void ゴミ箱へ移す権限が無ければ_失敗として記録し_Drive_には残す() throws Exception {
        Path p = put("a/b/c.dcm", rnd(100, 60));
        svc.cycle();
        String id = drive.live("a~b~c.dcm").get(0).id;
        Files.delete(p);
        drive.reason403 = "insufficientFilePermissions";
        drive.faults.add((m, path, ex) -> m.equals("PATCH") && path.startsWith("/drive/v3/files/") ? 403 : null);
        svc.syncNow();
        svc.cycle();
        assertFalse(drive.files.get(id).trashed, "Drive には残る");
        assertEquals(1, svc.status().blocked());
        assertEquals(GdriveSyncService.State.NEEDS_ATTENTION, svc.status().state());
        assertNotNull(repo.findById("a/b/c.dcm").orElseThrow().getLastError());
    }

    @Test
    void md5_が合わなければ同期済みにしない() throws Exception {
        put("a/b/c.dcm", rnd(100, 70));
        drive.wrongMd5 = "00000000000000000000000000000000";
        svc.cycle();
        assertEquals(0, svc.status().synced());
        assertEquals(1, svc.status().pending());
        assertEquals("md5-mismatch", repo.findAll().get(0).getLastError());
    }

    @Test
    void 状態と設定の文字列に秘密を含めない() throws Exception {
        put("a/b/c.dcm", rnd(100, 80));
        svc.cycle();
        String dump = svc.status().toString() + cfg(FOLDER)
                + new GdriveInternalController.ConfigBody(true, "cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", null, "dev-AAAA-0001", "hostA");
        assertFalse(dump.contains("rtoken-SECRET"));
        assertFalse(dump.contains("csecret"));
    }

    @Test
    void 同期先のフォルダを変えたら_古い台帳を捨てて出し直す() throws Exception {
        put("a/b/c.dcm", rnd(100, 90));
        svc.cycle();
        drive.files.put("OTHERfolder0001x", folder("OTHERfolder0001x"));
        svc.configure(cfg("OTHERfolder0001x"));
        svc.cycle();
        assertEquals(2, drive.liveCount(), "新しい同期先へも出す");
        assertTrue(repo.findAll().stream().allMatch(i -> i.getFolderId().equals("OTHERfolder0001x")));
    }
}
