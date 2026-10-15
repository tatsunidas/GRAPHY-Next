/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.FileTime;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 監視フォルダの走査（{@code scanOnce()} を直接呼ぶ。実時間の待ちは使わない）。 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:importwatch;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.import-watch.auto-run=false"
        })
@ActiveProfiles("standalone")
class ImportWatchServiceTest {

    /** DB フォルダ（保管庫は <db>/dicom）。監視フォルダはこの外に置く。 */
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
    DicomStorageService storage;

    Path src;
    static int seq;

    @BeforeEach
    void setUp() throws IOException {
        ledger.deleteAll();
        src = Files.createDirectories(outside.resolve("src" + (seq++)));
        configure(true, src.toString(), "5");
    }

    void configure(boolean enabled, String folder, String interval) {
        settings.putAll(Map.of(ImportWatchService.KEY_ENABLED, Boolean.toString(enabled),
                ImportWatchService.KEY_FOLDER, folder, ImportWatchService.KEY_INTERVAL, interval));
    }

    private Path dicom(String name, String study, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("W1", study, study + ".s", sop);
        return DicomPhantomFactory.writeFile(src.resolve(name), ds, UID.ExplicitVRLittleEndian);
    }

    private int indexed(String study) {
        return storage.findMatches(null, study, null, null).size();
    }

    @Test
    void 初見では取り込まず_同じ大きさと時刻の次の走査で取り込み_以後は何もしない() throws Exception {
        Path f = dicom("a.dcm", "1.2.w.one", "1.2.w.one.1");

        ImportWatchService.Status s1 = watch.scanOnce();
        assertEquals(1, s1.waiting());
        assertEquals(0, s1.imported());
        assertEquals(0, indexed("1.2.w.one"), "初見は取り込まない");

        ImportWatchService.Status s2 = watch.scanOnce();
        assertEquals(0, s2.waiting());
        assertEquals(1, s2.imported());
        assertEquals(1, indexed("1.2.w.one"));
        assertTrue(Files.exists(f), "原本はフォルダに残る");

        for (int i = 0; i < 3; i++) {
            ImportWatchService.Status s = watch.scanOnce();
            assertEquals(1, s.imported(), "台帳により再取り込みしない");
            assertEquals(0, s.waiting(), "処理済みは待機にも戻らない");
        }
        assertEquals(1, indexed("1.2.w.one"));
        assertEquals(1, ledger.count());
    }

    @Test
    void 追記が続いている間は取り込まず_止まった次の走査で取り込む() throws Exception {
        Path f = dicom("grow.dcm", "1.2.w.grow", "1.2.w.grow.1");
        byte[] full = Files.readAllBytes(f);
        Files.write(f, java.util.Arrays.copyOf(full, full.length / 2)); // 半分だけ書いた状態
        watch.scanOnce();
        Files.write(f, java.util.Arrays.copyOf(full, full.length * 3 / 4)); // 追記
        ImportWatchService.Status s = watch.scanOnce();
        assertEquals(1, s.waiting(), "追記が続く間は待機");
        assertEquals(0, s.imported());
        Files.write(f, full); // 書き終わり
        s = watch.scanOnce();
        assertEquals(1, s.waiting(), "大きさが変わった走査では、まだ待機");
        assertEquals(0, indexed("1.2.w.grow"));
        s = watch.scanOnce();
        assertEquals(1, s.imported());
        assertEquals(1, indexed("1.2.w.grow"));
    }

    @Test
    void 同じ大きさで更新時刻だけ変わっても_待ち直して取り込み直す() throws Exception {
        Path f = dicom("t.dcm", "1.2.w.time", "1.2.w.time.1");
        watch.scanOnce();
        watch.scanOnce();
        assertEquals(1, ledger.countByStatus(ImportWatchItem.IMPORTED));
        Files.setLastModifiedTime(f, FileTime.fromMillis(Files.getLastModifiedTime(f).toMillis() + 60_000));
        ImportWatchService.Status s = watch.scanOnce();
        assertEquals(1, s.waiting(), "更新時刻が変わったら別のファイルとして待つ");
        s = watch.scanOnce();
        assertEquals(0, s.waiting());
        assertEquals(1, indexed("1.2.w.time"), "DICOM の再取り込みは同じ SOP の上書きで 1 件のまま");
        assertEquals(1, ledger.count());
    }

    @Test
    void 非DICOMはスキップ_壊れたDICOMは失敗で数え_走査は続く() throws Exception {
        Files.writeString(src.resolve("readme.txt"), "not dicom");
        Path bad = dicom("bad.dcm", "1.2.w.bad", "1.2.w.bad.1");
        byte[] b = Files.readAllBytes(bad);
        Files.write(bad, java.util.Arrays.copyOf(b, 140)); // DICM の印だけある壊れたファイル
        dicom("ok.dcm", "1.2.w.okk", "1.2.w.okk.1");
        watch.scanOnce();
        ImportWatchService.Status s = watch.scanOnce();
        assertEquals(1, s.imported());
        assertEquals(1, s.skipped());
        assertEquals(1, s.failed());
        assertEquals(1, s.failures().size());
        assertTrue(s.failures().get(0).path().endsWith("bad.dcm"), "失敗はパス付きで出る");
        String why = s.failures().get(0).error();
        assertFalse(why.contains("bad.dcm") || why.contains("null"), "理由にパスの重複や null を含まない: " + why);
        assertNull(s.error());
        assertEquals(1, indexed("1.2.w.okk"), "失敗があっても他は取り込まれる");
    }

    @Test
    void 理由の整形_パスの重複と_null_を除く() {
        assertEquals("import-failed", ImportWatchService.reason("/a/b.dcm", "/a/b.dcm: null"));
        assertEquals("import-failed", ImportWatchService.reason("/a/b.dcm", null));
        assertEquals("必須 UID が欠落", ImportWatchService.reason("/a/b.dcm", "/a/b.dcm: 必須 UID が欠落"));
        assertEquals("other: x", ImportWatchService.reason("/a/b.dcm", "other: x"));
    }

    @Test
    void サブフォルダも走査する() throws Exception {
        Path sub = Files.createDirectories(src.resolve("p1/study"));
        Attributes ds = DicomPhantomFactory.scImage("W1", "1.2.w.sub", "1.2.w.sub.s", "1.2.w.sub.1");
        DicomPhantomFactory.writeFile(sub.resolve("x.dcm"), ds, UID.ExplicitVRLittleEndian);
        watch.scanOnce();
        watch.scanOnce();
        assertEquals(1, indexed("1.2.w.sub"));
    }

    @Test
    void 無効なら何もせず_最終走査の時刻も進まない() throws Exception {
        configure(true, src.toString(), "5");
        Long t0 = watch.scanOnce().lastScanAt();
        Thread.sleep(5);
        assertTrue(watch.scanOnce().lastScanAt() > t0, "有効なら走査のたびに時刻が進む（対照）");
        configure(false, src.toString(), "5");
        dicom("d.dcm", "1.2.w.off", "1.2.w.off.1");
        ImportWatchService.Status s = watch.scanOnce();
        Thread.sleep(5);
        watch.scanOnce();
        watch.scanOnce();
        assertEquals(s.lastScanAt(), watch.status().lastScanAt(), "無効の間は最終走査の時刻が進まない");
        assertEquals(0, indexed("1.2.w.off"));
        assertEquals(0, ledger.count());
        assertFalse(s.enabled());
    }

    @Test
    void 監視フォルダが無くても例外にならず_状態にエラーが出る() {
        configure(true, outside.resolve("no-such").toString(), "5");
        ImportWatchService.Status s = watch.scanOnce();
        assertEquals("folder-not-found", s.error());
        assertTrue(s.lastScanAt() != null, "走査は試みた");
        configure(true, src.toString(), "0");
        assertEquals("interval-invalid", watch.scanOnce().error());
        configure(true, "", "5");
        assertEquals("folder-missing", watch.scanOnce().error());
    }

    @Test
    void 保管庫の中と_DBフォルダを含む場所は監視先にできない() throws Exception {
        Files.createDirectories(db.resolve("dicom"));
        configure(true, db.resolve("dicom").toString(), "5");
        assertEquals("folder-overlaps-db", watch.scanOnce().error());
        configure(true, db.toString(), "5");
        assertEquals("folder-overlaps-db", watch.scanOnce().error());
        configure(true, db.getParent().toString(), "5");
        assertEquals("folder-overlaps-db", watch.scanOnce().error(), "DB フォルダを含む親も拒否");
        configure(true, src.toString(), "5");
        assertNull(watch.scanOnce().error(), "外のフォルダは通る（正例）");
    }

    @Test
    void 手動の取り込みと監視で同じファイルを続けて取り込んでも索引は1件() throws Exception {
        Path f = dicom("m.dcm", "1.2.w.man", "1.2.w.man.1");
        // 手動
        assertEquals(1, importService.importPaths(java.util.List.of(f.toString())).imported());
        watch.scanOnce();
        watch.scanOnce();
        assertEquals(1, indexed("1.2.w.man"));
    }

    @Autowired
    ImportService importService;

    @Test
    void ファイル末尾への追記も検知して待ち直す() throws Exception {
        Path f = dicom("ap.dcm", "1.2.w.app", "1.2.w.app.1");
        watch.scanOnce();
        Files.write(f, new byte[] {0, 0}, StandardOpenOption.APPEND);
        assertEquals(1, watch.scanOnce().waiting());
    }
}
