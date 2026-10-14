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
import java.util.List;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 索引スナップショット・排他・復元（P1-3）。偽の Drive を相手に、正例と負例を確かめる。 */
@DataJpaTest(properties = {"spring.jpa.hibernate.ddl-auto=create-drop"})
class GdriveBackupFlowTest {

    static final String FOLDER = "GRAPHYfolder0001";
    static final long LEASE = 600_000;
    static final long SNAP_EVERY = 3_600_000;

    @Autowired
    GdriveSyncRepository repo;

    @TempDir
    Path rootA;
    @TempDir
    Path rootB;
    @TempDir
    Path restored;

    FakeDrive drive;
    long now = 1_700_000_000_000L;
    final AtomicInteger backups = new AtomicInteger();
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
    }

    @AfterEach
    void tearDown() {
        drive.close();
    }

    GdriveSyncService service(Path root, String device, String host) {
        GdriveSyncService s = new GdriveSyncService(repo, root, drive.base(), drive.tokenUrl(), clock, () -> 0.5, 30_000,
                600_000, false, zip -> {
                    backups.incrementAndGet();
                    GdriveSyncServiceTest.fakeBackup(zip);
                }, LEASE, SNAP_EVERY, 3);
        s.configure(new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", device, host));
        return s;
    }

    private static byte[] rnd(int n, long seed) {
        byte[] b = new byte[n];
        new Random(seed).nextBytes(b);
        return b;
    }

    private static Path put(Path root, String rel, byte[] data) throws IOException {
        Path p = root.resolve(rel);
        Files.createDirectories(p.getParent());
        Files.write(p, data);
        return p;
    }

    private long snapshotsOnDrive() {
        return drive.files.values().stream().filter(f -> !f.folder && !f.trashed && f.name.startsWith("graphy-index-")).count();
    }

    // ── スナップショット ──

    @Test
    void 待ちが空になったらスナップショットを送り_間隔内は再送しない() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        put(rootA, "1/2/3.dcm", rnd(1000, 1));
        a.cycle();
        assertEquals(1, snapshotsOnDrive());
        assertEquals(1, backups.get());
        assertNotNull(a.status().lastSnapshotAt());
        now += 1_800_000; // 間隔（60 分）の半分
        a.cycle();
        assertEquals(1, backups.get(), "間隔内は作らない");
    }

    @Test
    void まだ送っていないファイルがあるうちはスナップショットを作らない() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        put(rootA, "1/2/3.dcm", rnd(1000, 2));
        drive.faults.add((m, p, ex) -> drive.dcmStart(p) ? 503 : null);
        a.cycle();
        assertEquals(1, a.status().pending());
        assertEquals(0, backups.get(), "索引が Drive に無いファイルを指す状態のスナップショットは作らない");
    }

    @Test
    void 世代は最新3つだけ残し_古いものはゴミ箱へ() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        put(rootA, "1/2/3.dcm", rnd(1000, 3));
        for (int i = 0; i < 5; i++) {
            a.cycle();
            now += SNAP_EVERY + 1000;
        }
        assertEquals(5, backups.get());
        assertEquals(3, snapshotsOnDrive(), "残るのは 3 世代");
        long trashed = drive.files.values().stream().filter(f -> f.name.startsWith("graphy-index-") && f.trashed).count();
        assertEquals(2, trashed, "古い 2 つはゴミ箱（完全削除ではない）");
    }

    @Test
    void 再起動後はDriveの最新時刻を読み_すぐ作り直さない() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        a.cycle();
        assertEquals(1, backups.get());
        a.shutdownWork();
        now += 60_000;
        GdriveSyncService again = service(rootA, "dev-AAAA-0001", "hostA"); // 再起動の代わり
        again.cycle();
        assertEquals(2, backups.get(), "終了時の 1 回を含めて 2 回。再起動では増えない");
    }

    // ── 排他 ──

    @Test
    void 他の端末が使用中なら同期せず_理由と相手を示す() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        put(rootA, "1/2/3.dcm", rnd(1000, 4));
        a.cycle();
        assertEquals(GdriveSyncService.State.CONNECTED, a.status().state());

        GdriveSyncService b = service(rootB, "dev-BBBB-0002", "hostB");
        put(rootB, "9/9/9.dcm", rnd(1000, 5));
        b.cycle();
        assertEquals(GdriveSyncService.State.NEEDS_ATTENTION, b.status().state());
        assertEquals("locked-by-other", b.status().reason());
        assertEquals("hostA", b.status().lockedBy());
        assertEquals(1, drive.liveCount(), "B は何も送らない");
        assertEquals(1, drive.files.values().stream().filter(f -> f.name.startsWith("lock-") && !f.trashed).count());
    }

    @Test
    void リースが切れた他端末のロックは_そのまま引き継げる() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        a.cycle();
        now += LEASE + 1000;
        GdriveSyncService b = service(rootB, "dev-BBBB-0002", "hostB");
        put(rootB, "9/9/9.dcm", rnd(1000, 6));
        b.cycle();
        assertEquals(GdriveSyncService.State.CONNECTED, b.status().state());
        assertEquals(1, drive.live("9~9~9.dcm").size());
    }

    @Test
    void 利用者が確認して奪取したら_相手のロックを外して始める_元の端末は止まる() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        a.cycle();
        GdriveSyncService b = service(rootB, "dev-BBBB-0002", "hostB");
        b.cycle();
        assertEquals("locked-by-other", b.status().reason());
        b.takeOver();
        b.cycle();
        assertEquals(GdriveSyncService.State.CONNECTED, b.status().state());
        now += LEASE; // A の次の更新時期
        a.cycle();
        assertEquals("lock-lost", a.status().reason(), "奪われた A は止まる");
        assertEquals(GdriveSyncService.State.NEEDS_ATTENTION, a.status().state());
    }

    @Test
    void 更新を続けている間はリースが切れない() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        a.cycle();
        for (int i = 0; i < 5; i++) {
            now += LEASE / 2;
            a.cycle();
        }
        GdriveSyncService b = service(rootB, "dev-BBBB-0002", "hostB");
        b.cycle();
        assertEquals("locked-by-other", b.status().reason(), "生きているロックは奪われない");
    }

    @Test
    void 終了時にロックを解放し_次の端末がすぐ使える() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        a.cycle();
        a.shutdownWork();
        GdriveSyncService b = service(rootB, "dev-BBBB-0002", "hostB");
        b.cycle();
        assertEquals(GdriveSyncService.State.CONNECTED, b.status().state());
    }

    // ── 復元 ──

    private GdriveConfig source() {
        return new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "restore", "restore-device", "");
    }

    private GdriveRestoreService restoreService() {
        return new GdriveRestoreService(drive.base(), drive.tokenUrl());
    }

    @Test
    void 別の空フォルダへ復元し_件数とmd5と索引が一致する() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        byte[] d1 = rnd(300_000, 7);
        byte[] d2 = rnd(DriveClient.CHUNK + 10, 8);
        put(rootA, "1.1/2.1/3.1.dcm", d1);
        put(rootA, "1.1/2.2/3.2.dcm", d2);
        a.cycle();

        GdriveRestoreService r = restoreService();
        r.runSync(source(), restored);
        assertEquals(GdriveRestoreService.Phase.DONE, r.progress().phase(), String.valueOf(r.progress()));
        assertEquals(2, r.progress().done());
        assertTrue(r.progress().snapshotRestored());
        assertEquals(FakeDrive.md5(d1), FakeDrive.md5(Files.readAllBytes(restored.resolve("dicom/1.1/2.1/3.1.dcm"))));
        assertEquals(FakeDrive.md5(d2), FakeDrive.md5(Files.readAllBytes(restored.resolve("dicom/1.1/2.2/3.2.dcm"))));
        assertEquals("INDEX-V1", extractIndex(restored.resolve("graphy-index.mv.db")));
    }

    /** 2 件目の取得を落とす。JDK の HttpClient は閉じた接続の GET を 1 回だけ自動でやり直すので、2 回続けて落とす。 */
    private static boolean isDrop(int n) {
        return n == 2 || n == 3;
    }

    private static String extractIndex(Path p) throws IOException {
        return Files.readString(p);
    }

    @Test
    void 取得中に中身が化けたら置かない() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        put(rootA, "1.1/2.1/3.1.dcm", rnd(1000, 9));
        a.cycle();
        drive.corruptDownloads = true;
        GdriveRestoreService r = restoreService();
        r.runSync(source(), restored);
        assertEquals(GdriveRestoreService.Phase.FAILED, r.progress().phase());
        assertEquals("md5-mismatch", r.progress().error());
        assertFalse(Files.exists(restored.resolve("dicom/1.1/2.1/3.1.dcm")), "壊れたものを正規の場所に置かない");
        assertFalse(Files.exists(restored.resolve("graphy-index.mv.db")));
    }

    @Test
    void 途中で止まっても_やり直せば取得済みを飛ばして続きから進む() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        for (int i = 0; i < 3; i++) {
            put(rootA, "1.1/2.1/3." + i + ".dcm", rnd(1000, 10 + i));
        }
        a.cycle();
        AtomicInteger gets = new AtomicInteger();
        // 2 件目の取得で切れる
        FakeDrive.Fault dropSecond = (m, p, ex) -> m.equals("GET") && ex.getRequestURI().getRawQuery() != null
                && ex.getRequestURI().getRawQuery().contains("alt=media") && isDrop(gets.incrementAndGet()) ? -1 : null;
        drive.faults.add(dropSecond);
        drive.faults.add(dropSecond); // 自動の再送ぶん
        GdriveRestoreService r = restoreService();
        r.runSync(source(), restored);
        assertEquals(GdriveRestoreService.Phase.FAILED, r.progress().phase());
        long got = drive.log.stream().filter(l -> l.startsWith("GET /drive/v3/files/")).count();

        r.runSync(source(), restored);
        assertEquals(GdriveRestoreService.Phase.DONE, r.progress().phase(), String.valueOf(r.progress()));
        assertEquals(3, r.progress().done());
        long after = drive.log.stream().filter(l -> l.startsWith("GET /drive/v3/files/")).count() - got;
        // 2 回目の取得は、残りのファイル 2 件＋スナップショット 1 件だけ（1 件目は取り直さない）
        assertEquals(3, after, "取得済みの 1 件は取り直さない");
    }

    @Test
    void 空でないフォルダへは復元しない() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        a.cycle();
        Files.writeString(restored.resolve("something.txt"), "x");
        String err = restoreService().start(source(), restored);
        assertEquals("dest-not-empty", err);
        Files.delete(restored.resolve("something.txt"));
        Files.writeString(restored.resolve("graphy-index.mv.db"), "x");
        assertEquals("dest-not-empty", restoreService().start(source(), restored), "既に索引があるフォルダへは戻さない");
    }

    @Test
    void zipの展開は区切りや親ディレクトリを含む名前を受け付けない() throws Exception {
        Path zip = rootA.resolve("evil.zip");
        try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(Files.newOutputStream(zip))) {
            z.putNextEntry(new java.util.zip.ZipEntry("graphy-index.mv.db"));
            z.write("ok".getBytes());
            z.closeEntry();
            z.putNextEntry(new java.util.zip.ZipEntry("../escape.txt"));
            z.write("bad".getBytes());
            z.closeEntry();
        }
        assertThrows(IOException.class, () -> GdriveRestoreService.extract(zip, restored));
        assertFalse(Files.exists(restored.resolve("graphy-index.mv.db")), "検査に落ちたら何も展開しない");
        assertFalse(Files.exists(restored.getParent().resolve("escape.txt")));
    }

    @Test
    void 名前が想定外のファイルは復元しない() throws Exception {
        GdriveSyncService a = service(rootA, "dev-AAAA-0001", "hostA");
        a.cycle();
        String dicomId = drive.files.values().stream().filter(f -> f.folder && f.name.equals("dicom")).findFirst().orElseThrow().id;
        FakeDrive.File bad = new FakeDrive.File();
        bad.id = "badfile00000000000";
        bad.name = "..~..~passwd.dcm";
        bad.parent = dicomId;
        bad.bytes = "x".getBytes();
        drive.files.put(bad.id, bad);
        GdriveRestoreService r = restoreService();
        r.runSync(source(), restored);
        assertEquals(1, r.progress().skipped());
        assertFalse(Files.exists(restored.resolve("dicom/../passwd.dcm")));
    }

    // ── H2 の BACKUP TO（実物） ──

    @Test
    void H2のBACKUP_TOが作るzipの中身は_そのまま復元に使える形() throws Exception {
        Path dir = Files.createTempDirectory("h2bk");
        String url = "jdbc:h2:file:" + dir.resolve("graphy-index").toString().replace('\\', '/');
        Path zip = dir.resolve("out.zip");
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(url, "sa", "");
             java.sql.Statement st = c.createStatement()) {
            st.execute("create table t(id int)");
            st.execute("insert into t values (42)");
            st.execute("BACKUP TO '" + zip.toString().replace("'", "''") + "'");
        }
        List<String> names = new java.util.ArrayList<>();
        try (java.util.zip.ZipInputStream in = new java.util.zip.ZipInputStream(Files.newInputStream(zip))) {
            for (java.util.zip.ZipEntry e; (e = in.getNextEntry()) != null; ) {
                names.add(e.getName());
            }
        }
        assertTrue(names.contains("graphy-index.mv.db"), "zip の項目: " + names);
        assertTrue(names.stream().noneMatch(n -> n.contains("/") || n.contains("..")), "展開側の検査に通る名前: " + names);

        // 展開して開き、データが読める
        Path out = Files.createTempDirectory("h2restore");
        GdriveRestoreService.extract(zip, out);
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(
                "jdbc:h2:file:" + out.resolve("graphy-index").toString().replace('\\', '/'), "sa", "");
             java.sql.ResultSet rs = c.createStatement().executeQuery("select id from t")) {
            assertTrue(rs.next());
            assertEquals(42, rs.getInt(1));
        }
    }
}
