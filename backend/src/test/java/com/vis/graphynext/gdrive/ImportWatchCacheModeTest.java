/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.importer.ImportWatchRepository;
import com.vis.graphynext.importer.ImportWatchService;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 監視フォルダの取り込み × Google Drive モード A（Drive が正本・手元は容量上限つきのキャッシュ）。
 * 取り込んだ DICOM が Drive に載ること、追い出されたあとに元のファイルが更新されて再取り込みされても Drive と食い違わないこと、
 * CSV による上書きが「手元に無い（追い出し済み）」ファイルにも効く（Drive から取り寄せて書き換え、Drive へ送り直す）ことを確かめる。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:importwatchcache;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.import-watch.auto-run=false"
        })
@ActiveProfiles("standalone")
class ImportWatchCacheModeTest {

    static final String FOLDER = "GRAPHYfolder0001";
    static final long RECENT = 10 * 60_000;

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
    SettingsService settings;
    @Autowired
    StorageLayout layout;
    @Autowired
    GdriveSyncRepository syncRepo;
    @Autowired
    DicomInstanceRepository instances;

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
        syncRepo.deleteAll();
        drive = new FakeDrive();
        FakeDrive.File f = new FakeDrive.File();
        f.id = FOLDER;
        f.name = "GRAPHY-DB-t";
        f.folder = true;
        drive.files.put(FOLDER, f);
        sync = new GdriveSyncService(syncRepo, layout.root(), drive.base(), drive.tokenUrl(), clock, () -> 0.5, 30_000,
                600_000, false, GdriveSyncServiceTest::fakeBackup, 600_000, 3_600_000, 3);
        // 上限 1 バイト: 直近に読まれていない同期済みのファイルは、すべて追い出される
        sync.configure(new GdriveConfig("cid", "csecret", "rtoken-SECRET", FOLDER, null, "t", "dev-AAAA-0001", "hostA", true, 1));
        layout.setBackend(sync); // 読み出しが、手元に無いファイルを Drive から取り寄せる口
        src = Files.createDirectories(outside.resolve("src" + (seq++)));
        settings.putAll(Map.of(ImportWatchService.KEY_ENABLED, "true", ImportWatchService.KEY_FOLDER, src.toString(),
                ImportWatchService.KEY_INTERVAL, "5", ImportWatchService.KEY_CSV_OVERWRITE_DICOM, "false"));
    }

    @AfterEach
    void tearDown() {
        layout.setBackend(null);
        drive.close();
    }

    private Path dicom(Path dir, String name, String patient, String patientName, String study, String sop) throws Exception {
        Files.createDirectories(dir);
        Attributes ds = DicomPhantomFactory.scImage(patient, study, study + ".s", sop);
        ds.setString(Tag.PatientName, VR.PN, patientName);
        return DicomPhantomFactory.writeFile(dir.resolve(name), ds, UID.ExplicitVRLittleEndian);
    }

    private void scans(int n) {
        for (int i = 0; i < n; i++) {
            watch.scanOnce();
        }
    }

    /** 取り込みが発行する StorageChanged を、この試験用の同期にも渡す（本番では Bean が受け取る）。 */
    private void notifyChanged(String study, String sop) {
        sync.onStorageChanged(new StorageChanged(layout.toStored(localPath(study, sop))));
    }

    private String driveName(String study, String sop) {
        return study + "~" + study + ".s~" + sop + ".dcm";
    }

    private Path localPath(String study, String sop) {
        return layout.instancePath(study, study + ".s", sop);
    }

    /** 同期して、直近の読み出し保護の窓を過ぎさせ、追い出す。 */
    private void syncAndEvict() throws Exception {
        sync.cycle();
        now += RECENT + 60_000;
        sync.cycle();
    }

    @Test
    void 監視で取り込んだDICOMはDriveに載り_追い出されても索引と台帳は残る() throws Exception {
        dicom(src, "a.dcm", "MA-1", "Mode^A", "1.2.ma.one", "1.2.ma.one.1");
        scans(2);
        assertEquals(1, instances.findByStudyInstanceUid("1.2.ma.one").size());

        syncAndEvict();

        assertEquals(1, drive.live(driveName("1.2.ma.one", "1.2.ma.one.1")).size(), "Drive に 1 件");
        assertFalse(Files.exists(localPath("1.2.ma.one", "1.2.ma.one.1")), "手元は追い出されている");
        assertEquals(1, instances.findByStudyInstanceUid("1.2.ma.one").size(), "索引は残る");
        assertTrue(Files.exists(src.resolve("a.dcm")), "監視フォルダの原本は触らない");
        scans(3);
        assertEquals(1, ledger.countByStatus("IMPORTED"), "追い出しても、監視は取り込み直さない");
        assertEquals(1, drive.live(driveName("1.2.ma.one", "1.2.ma.one.1")).size());
    }

    @Test
    void 追い出されたあとに元のファイルが更新されて再取り込みされても_Driveは新しい中身で1件() throws Exception {
        Path f = dicom(src, "b.dcm", "MA-2", "Before^Update", "1.2.ma.two", "1.2.ma.two.1");
        scans(2);
        syncAndEvict();
        assertFalse(Files.exists(localPath("1.2.ma.two", "1.2.ma.two.1")), "前提: 追い出されている");

        dicom(src, "b.dcm", "MA-2", "After^Update", "1.2.ma.two", "1.2.ma.two.1"); // 同じ SOP の別の中身
        Files.setLastModifiedTime(f, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 60_000));
        scans(2);
        assertTrue(Files.exists(localPath("1.2.ma.two", "1.2.ma.two.1")), "再取り込みで手元に実体が戻る");
        assertEquals("After^Update", instances.findByStudyInstanceUid("1.2.ma.two").get(0).getPatientName());

        notifyChanged("1.2.ma.two", "1.2.ma.two.1");
        sync.cycle();

        List<FakeDrive.File> d = drive.live(driveName("1.2.ma.two", "1.2.ma.two.1"));
        assertEquals(1, d.size(), "Drive は 1 件のまま");
        assertArrayEquals(Files.readAllBytes(localPath("1.2.ma.two", "1.2.ma.two.1")), d.get(0).bytes, "Drive が新しい中身になる");
        assertEquals(0, drive.files.values().stream().filter(x -> x.trashed).count(), "ゴミ箱には何も入らない");
        assertEquals(0, sync.status().pending());
    }

    @Test
    void CSVで上書きするとき_追い出し済みの同じスタディの画像もDriveから取り寄せて書き換える() throws Exception {
        // 1 枚目を取り込んで追い出す
        Path unit = src.resolve("subj");
        dicom(unit, "i1.dcm", "MA-3-OLD", "Old^Name", "1.2.ma.three", "1.2.ma.three.1");
        scans(2);
        syncAndEvict();
        assertFalse(Files.exists(localPath("1.2.ma.three", "1.2.ma.three.1")), "前提: 1 枚目は追い出されている");

        // 同じスタディの 2 枚目と CSV が届く。上書きをオンにする
        settings.putAll(Map.of(ImportWatchService.KEY_CSV_OVERWRITE_DICOM, "true"));
        dicom(unit, "i2.dcm", "MA-3-OLD", "Old^Name", "1.2.ma.three", "1.2.ma.three.2");
        Files.writeString(unit.resolve("p.csv"), "PatientID,PatientName\nMA-3-NEW,New^Name\n");
        scans(4);

        List<DicomInstance> rows = instances.findByStudyInstanceUid("1.2.ma.three");
        assertEquals(2, rows.size());
        assertTrue(rows.stream().allMatch(r -> "MA-3-NEW".equals(r.getPatientId()) && "New^Name".equals(r.getPatientName())),
                "追い出し済みの 1 枚目も含めて、CSV の患者属性になる");
        assertEquals(null, watch.status().error(), "上書きの失敗は出ない");
        // 1 枚目のファイルの中身も書き換わっている（取り寄せて書き換えた）
        Path first = localPath("1.2.ma.three", "1.2.ma.three.1");
        assertTrue(Files.exists(first), "取り寄せて書き換えたので、手元に戻っている");
        try (DicomInputStream in = new DicomInputStream(first.toFile())) {
            Attributes ds = in.readDataset();
            assertEquals("MA-3-NEW", ds.getString(Tag.PatientID));
            assertEquals("New^Name", ds.getString(Tag.PatientName));
        }

        notifyChanged("1.2.ma.three", "1.2.ma.three.1");
        notifyChanged("1.2.ma.three", "1.2.ma.three.2");
        sync.cycle();
        List<FakeDrive.File> d = drive.live(driveName("1.2.ma.three", "1.2.ma.three.1"));
        assertEquals(1, d.size(), "Drive は 1 件のまま");
        assertArrayEquals(Files.readAllBytes(first), d.get(0).bytes, "Drive にも書き換え後の中身が載る");
    }
}
