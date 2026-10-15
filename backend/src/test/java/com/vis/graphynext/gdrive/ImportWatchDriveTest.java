/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.importer.ImportService;
import com.vis.graphynext.importer.ImportWatchRepository;
import com.vis.graphynext.importer.ImportWatchService;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 監視フォルダの取り込み × Google Drive モード B（ローカル正本＋Drive バックアップ）。
 * 監視で取り込んだ DICOM が、手動の取り込みと同じ経路で Drive へ載ること、Drive に送れない間も取り込みは
 * ローカルに成功すること、手動と併用しても重複しないことを、偽の Drive を相手に確かめる。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:importwatchdrive;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.import-watch.auto-run=false"
        })
@ActiveProfiles("standalone")
class ImportWatchDriveTest {

    static final String FOLDER = "GRAPHYfolder0001";

    @TempDir
    static Path db;
    @TempDir
    static Path outside;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> db.resolve("dicom").toString());
    }

    @Autowired
    ImportWatchService watch;
    @Autowired
    ImportWatchRepository ledger;
    @Autowired
    ImportService importService;
    @Autowired
    SettingsService settings;
    @Autowired
    DicomStorageService storage;
    @Autowired
    StorageLayout layout;
    @Autowired
    GdriveSyncRepository syncRepo;

    FakeDrive drive;
    GdriveSyncService sync;
    Path src;
    static int seq;
    long now = 1_000_000L;
    final Clock clock = new Clock() {
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId z) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(now); }
        @Override public long millis() { return now; }
    };

    @BeforeEach
    void setUp() throws Exception {
        ledger.deleteAll();
        drive = new FakeDrive();
        FakeDrive.File f = new FakeDrive.File();
        f.id = FOLDER;
        f.name = "GRAPHY-DB-t";
        f.folder = true;
        drive.files.put(FOLDER, f);
        syncRepo.deleteAll();
        sync = new GdriveSyncService(syncRepo, layout.root(), drive.base(), drive.tokenUrl(), clock, () -> 0.5, 30_000,
                600_000, false, GdriveSyncServiceTest::fakeBackup, 600_000, 3_600_000, 3);
        sync.configure(GdriveSyncServiceTest.cfg(FOLDER));
        src = Files.createDirectories(outside.resolve("src" + (seq++)));
        settings.putAll(Map.of(ImportWatchService.KEY_ENABLED, "true", ImportWatchService.KEY_FOLDER, src.toString(),
                ImportWatchService.KEY_INTERVAL, "5"));
    }

    @AfterEach
    void tearDown() {
        drive.close();
    }

    private void dicom(String name, String study, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("W1", study, study + ".s", sop);
        DicomPhantomFactory.writeFile(src.resolve(name), ds, UID.ExplicitVRLittleEndian);
    }

    private void watchImports() {
        watch.scanOnce(); // 初見は待機
        watch.scanOnce(); // 同じ大きさ・時刻で取り込み
    }

    private String driveName(String study, String sop) {
        return study + "~" + study + ".s~" + sop + ".dcm";
    }

    @Test
    void 監視で取り込んだDICOMは手動と同じ経路でDriveへ載り_中身が一致する() throws Exception {
        dicom("a.dcm", "1.2.wd.a", "1.2.wd.a.1");
        dicom("b.dcm", "1.2.wd.a", "1.2.wd.a.2");
        watchImports();
        assertEquals(2, storage.findMatches(null, "1.2.wd.a", null, null).size());

        sync.cycle();

        List<FakeDrive.File> a = drive.live(driveName("1.2.wd.a", "1.2.wd.a.1"));
        assertEquals(1, a.size(), "Drive に 1 件");
        Path local = layout.instancePath("1.2.wd.a", "1.2.wd.a.s", "1.2.wd.a.1");
        assertArrayEquals(Files.readAllBytes(local), a.get(0).bytes, "Drive の中身がローカルと一致");
        assertEquals(1, drive.live(driveName("1.2.wd.a", "1.2.wd.a.2")).size());
        assertEquals(0, sync.status().pending());
    }

    @Test
    void Driveに送れない間も取り込みはローカルに成功し_復帰後に載る() throws Exception {
        dicom("c.dcm", "1.2.wd.c", "1.2.wd.c.1");
        drive.faults.add((m, path, ex) -> drive.dcmStart(path) ? -1 : null);
        watchImports();
        assertEquals(1, storage.findMatches(null, "1.2.wd.c", null, null).size(), "オフラインでも取り込めている");

        sync.cycle();
        assertEquals(GdriveSyncService.State.OFFLINE, sync.status().state());
        assertEquals(0, drive.live(driveName("1.2.wd.c", "1.2.wd.c.1")).size(), "まだ Drive には無い");
        assertTrue(sync.status().pending() >= 1, "未送信が残る（同じ保管庫の他のテストの分も含む）");
        assertEquals(1, ledger.countByStatus("IMPORTED"), "監視の台帳は取り込み済み（Drive の状態に依らない）");

        now += 60_000;
        sync.cycle();
        assertEquals(1, drive.live(driveName("1.2.wd.c", "1.2.wd.c.1")).size());
        assertEquals(0, sync.status().pending());
    }

    @Test
    void 手動と監視で同じファイルを取り込んでもDriveは1件() throws Exception {
        dicom("d.dcm", "1.2.wd.d", "1.2.wd.d.1");
        importService.importPaths(List.of(src.resolve("d.dcm").toString()));
        sync.cycle();
        assertEquals(1, drive.live(driveName("1.2.wd.d", "1.2.wd.d.1")).size());

        watchImports();
        sync.cycle();
        assertEquals(1, storage.findMatches(null, "1.2.wd.d", null, null).size(), "索引は 1 件");
        assertEquals(1, drive.live(driveName("1.2.wd.d", "1.2.wd.d.1")).size(), "Drive も 1 件のまま");
    }
}
