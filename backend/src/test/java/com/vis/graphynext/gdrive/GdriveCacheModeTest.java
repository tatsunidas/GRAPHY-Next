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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * モード A（Drive 正本・ローカルは容量上限つきキャッシュ）の台帳・追い出し・reconcile を、偽の Drive で確かめる。
 * 守ること: 追い出しは手元だけを消し Drive に触れない／未送信・直近に読まれたものは消さない／
 * 手元に無いことを「削除」と取り違えない（削除は利用者の操作で明示的に伝わったときだけ）。
 */
@DataJpaTest(properties = {"spring.jpa.hibernate.ddl-auto=create-drop"})
class GdriveCacheModeTest {

    static final String FOLDER = "GRAPHYfolder0001";
    static final int KB100 = 100_000;

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
        FakeDrive.File f = new FakeDrive.File();
        f.id = FOLDER;
        f.name = "GRAPHY-DB-t";
        f.folder = true;
        drive.files.put(FOLDER, f);
        svc = new GdriveSyncService(repo, root, drive.base(), drive.tokenUrl(), clock, () -> 0.5, 30_000, 600_000, false,
                GdriveSyncServiceTest::fakeBackup, 600_000, 3_600_000, 3);
    }

    @AfterEach
    void tearDown() {
        drive.close();
    }

    private void cacheOn(long limit) {
        svc.configure(new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", "dev-AAAA-0001", "hostA", true, limit));
    }

    private Path put(String rel, int size, long seed) throws IOException {
        Path p = root.resolve(rel);
        Files.createDirectories(p.getParent());
        byte[] b = new byte[size];
        new Random(seed).nextBytes(b);
        Files.write(p, b);
        return p;
    }

    private void advance(long ms) {
        now += ms;
    }

    private static final String A = "1.1/2.1/3.1.dcm";
    private static final String B = "1.1/2.1/3.2.dcm";
    private static final String C = "1.1/2.1/3.3.dcm";

    /** A, B, C を 11 分ずつ空けて 1 件ずつ同期する（直近保護の窓を外す）。 */
    private void syncThree() throws IOException {
        for (String rel : new String[] {A, B, C}) {
            put(rel, KB100, rel.hashCode());
            svc.onStorageChanged(new StorageChanged(rel)); // 取り込みが伝える通知（全走査に頼らない）
            svc.cycle();
            advance(11 * 60_000);
        }
    }

    // ── 正例 ──

    @Test
    void 上限を超えたら_古いものから手元だけを消し_Drive_には全件が残る() throws Exception {
        cacheOn(250_000);
        syncThree();
        svc.cycle();
        assertFalse(Files.exists(root.resolve(A)), "いちばん古い A が追い出される");
        assertTrue(Files.exists(root.resolve(B)));
        assertTrue(Files.exists(root.resolve(C)));
        assertTrue(repo.findById(A).orElseThrow().isEvicted());
        assertEquals(3, drive.liveCount(), "Drive には 3 件とも残る");
        assertEquals(0, drive.files.values().stream().filter(f -> f.trashed).count(), "ゴミ箱には何も入らない");
        GdriveSyncService.Status s = svc.status();
        assertEquals("cache", s.mode());
        assertEquals(2 * KB100, s.cacheBytes());
        assertEquals(250_000, s.cacheLimitBytes());
        assertEquals(2, s.localCount());
        assertEquals(1, s.evictedCount());
        assertTrue(s.cacheBytes() <= s.cacheLimitBytes());
    }

    @Test
    void 追い出し済みは_全走査で削除と取り違えない() throws Exception {
        cacheOn(250_000);
        syncThree();
        svc.cycle();
        long uploads = drive.dcmStarts();
        svc.syncNow();
        svc.cycle();
        svc.syncNow();
        svc.cycle();
        assertEquals(3, drive.liveCount());
        assertEquals(0, drive.files.values().stream().filter(f -> f.trashed).count());
        GdriveSyncItem a = repo.findById(A).orElseThrow();
        assertTrue(a.isEvicted());
        assertEquals(GdriveSyncItem.SYNCED, a.getState());
        assertEquals(uploads, drive.dcmStarts(), "何も送り直さない");
    }

    @Test
    void 読まれたものは新しいものとして扱い_追い出しの順が変わる() throws Exception {
        cacheOn(250_000);
        for (String rel : new String[] {A, B, C}) {
            put(rel, KB100, rel.hashCode());
            // 上限を一時的に大きくして、3 件とも手元に置く
            svc.configure(new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", "dev-AAAA-0001", "hostA", true, 10_000_000));
            svc.cycle();
            advance(11 * 60_000);
        }
        svc.touch(A); // A を読んだ（いちばん古いが、いま使われた）
        advance(11 * 60_000);
        cacheOn(250_000);
        svc.cycle();
        assertTrue(Files.exists(root.resolve(A)), "読まれた A は残る");
        assertFalse(Files.exists(root.resolve(B)), "代わりに B が追い出される");
        assertTrue(Files.exists(root.resolve(C)));
    }

    @Test
    void 利用者の削除は_追い出し済みでも_Drive_のゴミ箱へ移る() throws Exception {
        cacheOn(250_000);
        syncThree();
        svc.cycle();
        assertTrue(repo.findById(A).orElseThrow().isEvicted());
        String id = repo.findById(A).orElseThrow().getDriveFileId();
        svc.onStorageChanged(new StorageChanged(A)); // 削除の操作（DbAdminService）が伝える
        svc.cycle();
        assertTrue(drive.files.get(id).trashed, "Drive ではゴミ箱へ");
        assertTrue(repo.findById(A).isEmpty(), "台帳から外れる");
        assertEquals(2, drive.liveCount());
    }

    @Test
    void 手元に実体が戻ったら_追い出しの印を外し_送り直さない() throws Exception {
        cacheOn(250_000);
        syncThree();
        svc.cycle();
        GdriveSyncItem a = repo.findById(A).orElseThrow();
        assertTrue(a.isEvicted());
        Path p = put(A, (int) a.getSize(), 99);
        Files.setLastModifiedTime(p, java.nio.file.attribute.FileTime.fromMillis(a.getMtime()));
        long uploads = drive.dcmStarts();
        cacheOn(10_000_000); // 戻した直後に追い出し直されないよう、上限を広げる
        svc.syncNow();
        svc.cycle();
        assertFalse(repo.findById(A).orElseThrow().isEvicted());
        assertEquals(uploads, drive.dcmStarts());
    }

    // ── 負例 ──

    @Test
    void 未送信は上限を超えていても追い出さない() throws Exception {
        cacheOn(150_000);
        put(A, KB100, 1);
        svc.cycle();
        advance(11 * 60_000);
        // 以降の新規送信は止まる（503）。B は未送信のまま残る
        drive.faults.add((m, path, ex) -> drive.dcmStart(path) ? 503 : null);
        put(B, KB100, 2);
        svc.cycle();
        GdriveSyncItem b = repo.findById(B).orElseThrow();
        assertEquals(GdriveSyncItem.PENDING, b.getState());
        assertTrue(Files.exists(root.resolve(B)), "未送信の B は消さない");
        assertFalse(repo.findById(B).orElseThrow().isEvicted());
        assertFalse(Files.exists(root.resolve(A)), "送信済みの A は追い出される");
    }

    @Test
    void 直近に同期した分は_上限を超えても追い出さない() throws Exception {
        cacheOn(150_000);
        for (String rel : new String[] {A, B, C}) {
            put(rel, KB100, rel.hashCode());
        }
        svc.cycle();
        assertTrue(Files.exists(root.resolve(A)) && Files.exists(root.resolve(B)) && Files.exists(root.resolve(C)),
                "直近 10 分以内に同期した分は消さない（使用量は一時的に上限を超える）");
        advance(11 * 60_000);
        svc.cycle();
        assertEquals(1, root.resolve("1.1/2.1").toFile().list((d, n) -> n.endsWith(".dcm")).length, "窓を過ぎたら上限まで追い出す");
    }

    @Test
    void 同期のあとで手元が変わったものは追い出さない() throws Exception {
        // 全走査を実質止めた別のサービス（周期の evict だけが走る）
        svc = new GdriveSyncService(repo, root, drive.base(), drive.tokenUrl(), clock, () -> 0.5, 30_000, Long.MAX_VALUE / 4, false,
                GdriveSyncServiceTest::fakeBackup, 600_000, 3_600_000, 3);
        cacheOn(10_000_000);
        syncThree();
        Path p = root.resolve(A);
        Files.setLastModifiedTime(p, java.nio.file.attribute.FileTime.fromMillis(Files.getLastModifiedTime(p).toMillis() + 5000));
        cacheOn(150_000);
        svc.cycle();
        assertTrue(Files.exists(p), "台帳の mtime と合わない（同期のあとで変わった）ものは消さない");
        assertFalse(Files.exists(root.resolve(B)), "ほかの古いものは追い出される ");
    }

    @Test
    void 上限が無い設定は拒否する() {
        GdriveConfig c = new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", "dev-AAAA-0001", "hostA", true, 0);
        assertEquals("bad-cache-limit", c.problem());
        assertNull(new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", "dev-AAAA-0001", "hostA", false, 0).problem());
    }

    @Test
    void 直近の保護の長さは設定で変えられる_0分なら同期した直後でも追い出す() throws Exception {
        svc.recentAccessMs = 0;
        cacheOn(150_000);
        for (String rel : new String[] {A, B, C}) {
            put(rel, KB100, rel.hashCode());
            svc.onStorageChanged(new StorageChanged(rel));
        }
        svc.cycle();
        long local = java.util.stream.Stream.of(A, B, C).filter(r -> Files.exists(root.resolve(r))).count();
        assertEquals(1, local, "保護が 0 分なら、同じ周期のうちに上限（150KB）まで追い出される");
        assertEquals(3, drive.liveCount(), "Drive には 3 件とも残る");
    }

    @Test
    void 状態に手元の空き容量を載せる_モードAだけ() throws Exception {
        cacheOn(250_000);
        svc.usableSpace = () -> 123_456_789L;
        assertEquals(123_456_789L, svc.status().usableBytes());
        svc.configure(new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", "dev-AAAA-0001", "hostA", false, 0));
        assertEquals(0, svc.status().usableBytes(), "モード B には上限が無いので空き容量は出さない");
    }

    @Test
    void モード_B_では追い出さない() throws Exception {
        svc.configure(new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", "dev-AAAA-0001", "hostA", false, 0));
        syncThree();
        svc.cycle();
        assertTrue(Files.exists(root.resolve(A)) && Files.exists(root.resolve(B)) && Files.exists(root.resolve(C)));
        assertEquals("backup", svc.status().mode());
    }
}
