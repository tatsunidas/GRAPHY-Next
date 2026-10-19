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
import java.util.ArrayList;
import java.util.List;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * P2-3: (3a) Drive にだけあるファイルを索引へ取り込む／(3b) すべてローカルに保存する。
 * 守ること: 取り込みは通常の経路を通り、同じ内容を送り直さない／壊れたものは取り込まない／
 * 全件保存は空き容量が足りなければ何も取らない・実行中と完了後は追い出さない・つながらなければ止まり続きから再開できる。
 */
@DataJpaTest(properties = {"spring.jpa.hibernate.ddl-auto=create-drop"})
@org.springframework.transaction.annotation.Transactional(propagation = org.springframework.transaction.annotation.Propagation.NOT_SUPPORTED)
class GdriveAdoptLocalizeTest {

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
    final List<String> ingested = new ArrayList<>();
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
    }

    @AfterEach
    void tearDown() {
        drive.close();
        repo.deleteAll();
    }

    private void config(boolean cache, long limit) {
        svc.configure(new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", "dev-AAAA-0001", "hostA", cache, limit));
    }

    /**
     * 本物の ingest の代わり: 保管庫の正しい場所へ置き、同期へ変更を通知する（本物と同じ流れ）。
     * 🔴 この偽物は、壊れた内容や重複を自分で弾かない（弾くと、本体側の md5 照合・既知の除外が効いているのか分からなくなる）。
     * どの Drive ファイルか見分けるのに、先頭 1 バイトは見ない（取得中に化けるテストが先頭を壊すため）。
     */
    private void fakeIndexer() {
        svc.setIndexer(file -> {
            byte[] got = Files.readAllBytes(file);
            String name = null;
            for (FakeDrive.File d : drive.files.values()) {
                if (!d.folder && d.bytes.length == got.length && d.bytes.length > 0
                        && java.util.Arrays.equals(java.util.Arrays.copyOfRange(d.bytes, 1, d.bytes.length),
                                java.util.Arrays.copyOfRange(got, 1, got.length))) {
                    name = d.name;
                }
            }
            if (name == null || name.startsWith("BAD")) {
                throw new IOException("DICOM として読めない");
            }
            String rel = name.replace('~', '/');
            Path dest = root.resolve(rel);
            Files.createDirectories(dest.getParent());
            Files.move(file, dest, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            ingested.add(rel);
            svc.onStorageChanged(new StorageChanged(rel));
        });
    }

    private String dicomFolderId() {
        return drive.files.values().stream().filter(f -> f.folder && f.name.equals("dicom") && FOLDER.equals(f.parent))
                .findFirst().orElseThrow().id;
    }

    private FakeDrive.File remoteOnly(String name, int seed) {
        FakeDrive.File f = new FakeDrive.File();
        f.id = "remote-" + name.hashCode();
        f.name = name;
        f.parent = dicomFolderId();
        f.bytes = new byte[SIZE];
        new Random(seed).nextBytes(f.bytes);
        drive.files.put(f.id, f);
        return f;
    }

    // ── 3a: Drive にだけあるファイル ──

    @Test
    void 台帳に無いDriveのファイルを取得して索引へ載せ_同じ内容を送り直さない() throws Exception {
        config(true, 10_000_000);
        svc.cycle(); // dicom フォルダを作る
        fakeIndexer();
        FakeDrive.File x = remoteOnly("9.1~9.2~9.3.dcm", 1);
        FakeDrive.File y = remoteOnly("9.1~9.2~9.4.dcm", 2);
        long uploads = drive.dcmStarts();
        svc.syncNow();
        svc.cycle();
        svc.cycle(); // 取り込みの通知（変更）を処理して、台帳を SYNCED にする
        assertEquals(List.of("9.1/9.2/9.3.dcm", "9.1/9.2/9.4.dcm"), ingested.stream().sorted().toList());
        assertEquals(2, svc.status().adopted());
        assertEquals(uploads, drive.dcmStarts(), "同じ内容を Drive へ送り直さない");
        assertEquals(GdriveSyncItem.SYNCED, repo.findById("9.1/9.2/9.3.dcm").orElseThrow().getState());
        assertEquals(x.id, repo.findById("9.1/9.2/9.3.dcm").orElseThrow().getDriveFileId(), "既存の Drive のファイルに結び付く（重複しない）");
        assertEquals(2, drive.liveCount());
        assertTrue(Files.exists(root.resolve("9.1/9.2/9.4.dcm")));
        assertEquals(FakeDrive.md5(y.bytes), FakeDrive.md5(Files.readAllBytes(root.resolve("9.1/9.2/9.4.dcm"))));
    }

    @Test
    void 取り込み済みは_次の全走査で取り込み直さない() throws Exception {
        config(true, 10_000_000);
        svc.cycle();
        fakeIndexer();
        remoteOnly("9.1~9.2~9.3.dcm", 1);
        svc.syncNow();
        svc.cycle();
        svc.cycle();
        int first = ingested.size();
        svc.syncNow();
        svc.cycle();
        svc.syncNow();
        svc.cycle();
        assertEquals(first, ingested.size());
        assertEquals(1, svc.status().adopted());
    }

    @Test
    void 取得中に化けた_または読めないファイルは取り込まず_ほかは続ける() throws Exception {
        config(true, 10_000_000);
        svc.cycle();
        fakeIndexer();
        remoteOnly("BAD~1~1.dcm", 3);           // 取り込みで読めない
        remoteOnly("9.1~9.2~9.5.dcm", 4);       // 正常
        svc.syncNow();
        svc.cycle();
        svc.cycle();
        assertEquals(List.of("9.1/9.2/9.5.dcm"), ingested, "壊れた 1 件は飛ばし、正常な分は取り込む");
        assertEquals(1, svc.status().adopted());
        assertFalse(Files.exists(root.resolve("BAD/1/1.dcm")));

        drive.corruptDownloads = true; // 取得の途中で化ける
        remoteOnly("9.1~9.2~9.6.dcm", 5);
        svc.syncNow();
        svc.cycle();
        assertEquals(1, ingested.size(), "md5 が合わないものは取り込まない");
    }

    @Test
    void モードBでは取り込まない() throws Exception {
        config(false, 0);
        svc.cycle();
        fakeIndexer();
        remoteOnly("9.1~9.2~9.3.dcm", 1);
        svc.syncNow();
        svc.cycle();
        assertTrue(ingested.isEmpty());
        assertEquals(0, svc.status().adopted());
    }

    @Test
    void 名前の読み替えは_安全な形だけ() {
        assertEquals("1.1/2.1/3.1.dcm", GdriveSyncService.decodeName("1.1~2.1~3.1.dcm"));
        assertNull(GdriveSyncService.decodeName("lock-abc.json"));
        assertNull(GdriveSyncService.decodeName("noseparator.dcm"));
        assertNull(GdriveSyncService.decodeName("1~..~3.dcm"));
        assertNull(GdriveSyncService.decodeName("1~~3.dcm"));
        assertNull(GdriveSyncService.decodeName(".hidden~1~2.dcm"));
        assertNull(GdriveSyncService.decodeName(null));
    }

    // ── 3b: すべてローカルに保存 ──

    /** A, B, C を同期し、上限 250KB で A を追い出した状態にする。 */
    private void evictedA() throws IOException {
        config(true, 250_000);
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
        assertTrue(repo.findById(A).orElseThrow().isEvicted());
    }

    private GdriveSyncService.LocalizeProgress await(String... phases) throws Exception {
        long end = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < end) {
            GdriveSyncService.LocalizeProgress p = svc.localizeProgress();
            if (java.util.Arrays.asList(phases).contains(p.phase())) {
                return p;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("待ち切れず: " + svc.localizeProgress());
    }

    @Test
    void 全件保存は_すべて取り寄せ_完了後も追い出さず_解放すると追い出しが再開する() throws Exception {
        evictedA();
        assertNull(svc.startLocalize());
        GdriveSyncService.LocalizeProgress p = await("DONE", "FAILED");
        assertEquals("DONE", p.phase(), p.toString());
        assertEquals(1, p.total());
        assertEquals(1, p.done());
        assertEquals(0, svc.status().evictedCount());
        assertEquals(FakeDrive.md5(data[0]), FakeDrive.md5(Files.readAllBytes(root.resolve(A))));

        // 上限（250KB）を超えている（300KB）が、保存中・完了後は追い出さない
        now += 11 * 60_000;
        svc.cycle();
        svc.cycle();
        assertTrue(Files.exists(root.resolve(A)) && Files.exists(root.resolve(B)) && Files.exists(root.resolve(C)));
        assertEquals(0, svc.status().evictedCount());

        svc.cancelLocalize(); // 解放
        svc.cycle();
        assertEquals(1, svc.status().evictedCount(), "解放すると上限に従って追い出される");
    }

    @Test
    void 空き容量が足りなければ_何も取らず断る() throws Exception {
        evictedA();
        svc.usableSpace = () -> 1_000; // 100KB + 余裕に満たない
        long gets = drive.log.stream().filter(l -> l.startsWith("GET /drive/v3/files/")).count();
        assertEquals("not-enough-space", svc.startLocalize());
        assertEquals("IDLE", svc.localizeProgress().phase());
        assertEquals(gets, drive.log.stream().filter(l -> l.startsWith("GET /drive/v3/files/")).count(), "1 件も取りに行かない");
        assertFalse(Files.exists(root.resolve(A)));
        // 容量が足りる値なら通る（拒否が条件つきであることの対）
        svc.usableSpace = () -> 100_000L + GdriveSyncService.FREE_SPACE_MARGIN + 1;
        assertNull(svc.startLocalize());
        assertEquals("DONE", await("DONE", "FAILED").phase());
    }

    @Test
    void モードBでは受け付けない() throws Exception {
        config(false, 0);
        assertEquals("not-cache-mode", svc.startLocalize());
    }

    @Test
    void つながらなければ止まり_直ったら続きから再開できる() throws Exception {
        evictedA();
        // B, C も追い出された状態にする
        config(true, 100_000);
        now += 11 * 60_000;
        svc.cycle();
        assertEquals(2, svc.status().evictedCount());
        for (int i = 0; i < 6; i++) { // JDK の自動やり直しを考えて十分な回数、取得を切る
            drive.faults.add((m, path, ex) -> m.equals("GET") && path.startsWith("/drive/v3/files/") ? -1 : null);
        }
        assertNull(svc.startLocalize());
        GdriveSyncService.LocalizeProgress p = await("FAILED", "DONE");
        assertEquals("FAILED", p.phase());
        assertEquals("offline", p.error());
        assertTrue(svc.status().evictedCount() > 0, "取れなかった分は追い出し済みのまま");
        drive.faults.clear();
        assertNull(svc.startLocalize(), "再実行できる");
        assertEquals("DONE", await("DONE").phase());
        assertEquals(0, svc.status().evictedCount());
    }
}
