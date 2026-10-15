/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.nifti.NiftiImportService;
import com.vis.graphynext.nifti.NiftiToDicom;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.zip.GZIPOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 監視フォルダの NIfTI（段 3）。納品のフォルダ（ユニット）ごとに、画像・サイドカー JSON が揃うのを待ち、
 * 患者情報が無ければ警告して保留にし、他の処理は止めない。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:importwatchnifti;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.import-watch.auto-run=false"
        })
@ActiveProfiles("standalone")
class ImportWatchNiftiTest {

    static final int NX = WatchNiftiFixture.NX;
    static final int NY = WatchNiftiFixture.NY;
    static final int NZ = WatchNiftiFixture.NZ;
    static final double DX = WatchNiftiFixture.DX;
    static final double DY = WatchNiftiFixture.DY;

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
    DicomInstanceRepository instances;
    @Autowired
    StorageLayout layout;
    @Autowired
    NiftiImportService niftiImport;

    Path src;
    static int seq;

    @BeforeEach
    void setUp() throws IOException {
        ledger.deleteAll();
        src = Files.createDirectories(outside.resolve("src" + (seq++)));
        settings.putAll(Map.of(ImportWatchService.KEY_ENABLED, "true", ImportWatchService.KEY_FOLDER, src.toString(),
                ImportWatchService.KEY_INTERVAL, "5"));
    }

    static Path nifti(Path file, int seed) throws IOException {
        return WatchNiftiFixture.write(file, seed);
    }

    private void scans(int n) {
        for (int i = 0; i < n; i++) {
            watch.scanOnce();
        }
    }

    private List<DicomInstance> patient(String id) {
        return instances.findByPatientId(id);
    }

    private static String pixelSpacing(Path dcm) throws IOException {
        try (DicomInputStream in = new DicomInputStream(dcm.toFile())) {
            Attributes ds = in.readDataset();
            double[] ps = ds.getDoubles(Tag.PixelSpacing);
            return ps[0] + "\\" + ps[1] + " " + ds.getInt(Tag.Rows, 0) + "x" + ds.getInt(Tag.Columns, 0);
        }
    }

    @Test
    void 患者情報つきのサイドカーがあれば_ユニットが安定したあと取り込まれ_手動の取り込みと同じ形になる() throws Exception {
        Path unit = src.resolve("subj1");
        nifti(unit.resolve("t1.nii.gz"), 100);
        Files.writeString(unit.resolve("t1.json"),
                "{\"PatientID\":\"NW-001\",\"PatientName\":\"Test^Sub\",\"PatientBirthDate\":\"19800102\",\"PatientSex\":\"F\"}");

        ImportWatchService.Status s1 = watch.scanOnce();
        assertEquals(1, s1.waiting(), "初見は待機");
        assertEquals(0, patient("NW-001").size());
        ImportWatchService.Status s2 = watch.scanOnce();
        assertEquals(1, s2.imported());
        assertEquals(0, s2.skipped(), "ペアの json は数えない");
        assertEquals(0, s2.held());

        List<DicomInstance> got = patient("NW-001");
        assertEquals(NZ, got.size(), "スライス数");
        assertEquals("Test^Sub", got.get(0).getPatientName());
        assertEquals("19800102", got.get(0).getPatientBirthDate());
        assertEquals("F", got.get(0).getPatientSex());
        assertEquals("t1", got.get(0).getSeriesDescription(), "シリーズ名はファイル名");
        assertEquals(1, got.stream().map(DicomInstance::getSeriesInstanceUid).distinct().count());

        // 手動の取り込み（同じ変換）と、行列数・画素間隔が一致する
        NiftiToDicom.Options o = new NiftiToDicom.Options("MR", "NW-MAN", "Man^Ual", null, null, null, null, "man", 1,
                null, null, Map.of(), null);
        niftiImport.importFile(unit.resolve("t1.nii.gz"), Map.of(), o);
        List<DicomInstance> manual = patient("NW-MAN");
        assertEquals(NZ, manual.size());
        assertEquals(pixelSpacing(layout.resolveForRead(manual.get(0))), pixelSpacing(layout.resolveForRead(got.get(0))));
        assertEquals(DY + "\\" + DX + " " + NY + "x" + NX, pixelSpacing(layout.resolveForRead(got.get(0))),
                "画素間隔は行 DY・列 DX（真値は生成時の値）");

        scans(3);
        assertEquals(NZ, patient("NW-001").size(), "何回走査しても増えない");
        assertEquals(1, ledger.countByStatus(ImportWatchItem.IMPORTED));
    }

    @Test
    void 患者情報の無いNIfTIは取り込まれず保留になり_警告に出る() throws Exception {
        Path unit = src.resolve("subj2");
        nifti(unit.resolve("bold.nii"), 5);
        scans(3);
        ImportWatchService.Status s = watch.status();
        assertEquals(0, s.imported());
        assertEquals(1, s.held());
        assertEquals(1, s.heldItems().size());
        assertTrue(s.heldItems().get(0).path().endsWith("bold.nii"));
        assertEquals("no-patient-info", s.heldItems().get(0).error());
        assertNull(s.error(), "保留は異常ではない（走査は止まらない）");
        assertEquals(0, s.waiting(), "保留は待機にも数えない");
        assertTrue(instances.findAll().stream().noneMatch(i -> "bold".equals(i.getSeriesDescription())), "取り込まれていない");
    }

    @Test
    void 保留が出ても_他のユニットとDICOMは通常どおり取り込まれる() throws Exception {
        nifti(src.resolve("noinfo").resolve("a.nii.gz"), 1); // 保留になる
        Path ok = src.resolve("withinfo");
        nifti(ok.resolve("b.nii.gz"), 2);
        Files.writeString(ok.resolve("b.json"), "{\"PatientID\":\"NW-OK\"}");
        Attributes ds = DicomPhantomFactory.scImage("NW-DCM", "1.2.nw.dcm", "1.2.nw.dcm.s", "1.2.nw.dcm.1");
        DicomPhantomFactory.writeFile(src.resolve("loose.dcm"), ds, UID.ExplicitVRLittleEndian);
        Files.createDirectories(src.resolve("empty-unit"));

        scans(3);

        ImportWatchService.Status s = watch.status();
        assertEquals(1, s.held());
        assertEquals(2, s.imported(), "患者情報つきの NIfTI と DICOM が取り込まれる");
        assertEquals(NZ, patient("NW-OK").size());
        assertEquals(1, patient("NW-DCM").size());
        assertNull(s.error());
    }

    @Test
    void あとからサイドカーが揃えば保留が解けて取り込まれる() throws Exception {
        Path unit = src.resolve("late");
        nifti(unit.resolve("x.nii.gz"), 7);
        scans(3);
        assertEquals(1, watch.status().held());
        Files.writeString(unit.resolve("x.json"), "{\"PatientID\":\"NW-LATE\"}");
        ImportWatchService.Status s = watch.scanOnce();
        assertEquals(0, patient("NW-LATE").size(), "納品が変わった走査ではまだ取り込まない（揃うのを待つ）");
        assertEquals(1, s.held());
        s = watch.scanOnce();
        assertEquals(1, s.imported());
        assertEquals(0, s.held());
        assertEquals(NZ, patient("NW-LATE").size());
    }

    @Test
    void サイドカーを書いている間は待つ() throws Exception {
        Path unit = src.resolve("slow");
        nifti(unit.resolve("y.nii.gz"), 9);
        Files.writeString(unit.resolve("y.json"), "{\"PatientID\":\"NW-SL");
        watch.scanOnce();
        Files.writeString(unit.resolve("y.json"), "{\"PatientID\":\"NW-SLOW\"");
        watch.scanOnce();
        assertEquals(0, patient("NW-SLOW").size(), "書き込み途中のサイドカーでは取り込まない");
        assertEquals(0, ledger.countByStatus(ImportWatchItem.IMPORTED));
        Files.writeString(unit.resolve("y.json"), "{\"PatientID\":\"NW-SLOW\"}");
        watch.scanOnce();
        assertEquals(0, patient("NW-SLOW").size(), "書き終えた走査はまだ待つ");
        watch.scanOnce();
        assertEquals(NZ, patient("NW-SLOW").size());
    }

    @Test
    void 取り込み済みのNIfTIの中身が変わっても_再取り込みせず検知だけする() throws Exception {
        Path unit = src.resolve("chg");
        Path f = nifti(unit.resolve("z.nii.gz"), 3);
        Files.writeString(unit.resolve("z.json"), "{\"PatientID\":\"NW-CHG\"}");
        scans(2);
        assertEquals(NZ, patient("NW-CHG").size());
        nifti(f, 99); // 中身を変える
        Files.setLastModifiedTime(f, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 60_000));
        scans(4);
        ImportWatchService.Status s = watch.status();
        assertEquals(1, s.changed(), "更新を検知");
        assertEquals(NZ, patient("NW-CHG").size(), "インスタンスは増えない");
        assertEquals(1, patient("NW-CHG").stream().map(DicomInstance::getSeriesInstanceUid).distinct().count(),
                "シリーズは 1 本のまま");
    }

    @Test
    void 壊れたNIfTIは失敗_走査は続く() throws Exception {
        Path unit = src.resolve("bad");
        Files.createDirectories(unit);
        Files.write(unit.resolve("broken.nii"), new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 });
        Path ok = src.resolve("good");
        nifti(ok.resolve("g.nii"), 4);
        Files.writeString(ok.resolve("g.json"), "{\"PatientID\":\"NW-GOOD\"}");
        scans(3);
        ImportWatchService.Status s = watch.status();
        assertEquals(1, s.failed());
        assertEquals(NZ, patient("NW-GOOD").size());
    }

    @Test
    void 形式違いの値は無いものとして扱い_IDも名前も有効でなければ保留() throws Exception {
        Path a = src.resolve("v1");
        nifti(a.resolve("a.nii"), 1);
        Files.writeString(a.resolve("a.json"),
                "{\"PatientID\":\"NW-V1\",\"PatientBirthDate\":\"2020-13-45\",\"PatientSex\":\"X\"}");
        Path b = src.resolve("v2");
        nifti(b.resolve("b.nii"), 2);
        Files.writeString(b.resolve("b.json"), "{\"PatientID\":\"bad\\\\id\",\"PatientName\":\"\"}");
        scans(3);
        List<DicomInstance> got = patient("NW-V1");
        assertEquals(NZ, got.size(), "有効な ID があれば取り込む");
        assertTrue(got.get(0).getPatientBirthDate() == null || got.get(0).getPatientBirthDate().isEmpty(), "不正な生年月日は入れない");
        assertTrue(got.get(0).getPatientSex() == null || got.get(0).getPatientSex().isEmpty(), "不正な性別は入れない");
        ImportWatchService.Status s = watch.status();
        assertEquals(1, s.held(), "ID も名前も無効なら保留");
        assertEquals(1, s.imported());
    }

    @Test
    void 対のないjsonはスキップ() throws Exception {
        Path unit = Files.createDirectories(src.resolve("solo"));
        Files.writeString(unit.resolve("lonely.json"), "{}");
        scans(3);
        ImportWatchService.Status s = watch.status();
        assertEquals(1, s.skipped());
        assertEquals(0, s.imported());
    }

    @Test
    void 患者情報の検査_値の規則() {
        assertTrue(PatientFields.validLo("ABC-1"));
        assertFalse(PatientFields.validLo("a\\b"));
        assertFalse(PatientFields.validLo("x".repeat(65)));
        assertTrue(PatientFields.validLo("x".repeat(64)));
        assertFalse(PatientFields.validLo("tab\there"));
        assertTrue(PatientFields.validPn("Yamada^Taro=山田^太郎"));
        assertFalse(PatientFields.validPn(("x".repeat(65)) + "^a"));
        assertTrue(PatientFields.validDa("20240229"));
        assertFalse(PatientFields.validDa("20230229"));
        assertFalse(PatientFields.validDa("2024-02-29"));
        assertFalse(PatientFields.validDa("19801301"));
        assertTrue(PatientFields.validSex("O"));
        assertFalse(PatientFields.validSex("m"));
        assertTrue(PatientFields.validCs("MR"));
        assertFalse(PatientFields.validCs("mr"));
        assertEquals(Set.of("a"), Set.of(PatientFields.clean("  a ")));
        assertNull(PatientFields.clean("   "));
        assertNotNull(Set.of(1).stream().map(String::valueOf).collect(Collectors.toSet()));
    }
}
