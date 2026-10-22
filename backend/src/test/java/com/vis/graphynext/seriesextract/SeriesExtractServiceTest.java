/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.extract.TagExtractService.Seg;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
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
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SeriesExtractor の条件評価（Include/Exclude・演算子・平面）とフォルダコピー（連番・mapping.csv）を検証する。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:seriesextract;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
@ActiveProfiles("standalone")
class SeriesExtractServiceTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;
    @Autowired
    SeriesExtractService service;

    static final double[] AXIAL = {1, 0, 0, 0, 1, 0};
    static final double[] SAGITTAL = {0, 1, 0, 0, 0, -1};

    @BeforeEach
    void seed() throws Exception {
        // study ST.SX: 3 シリーズ
        ingestSeries("ST.SX", "SE1", "MR", "KNEE AX", 1, AXIAL, 2);
        ingestSeries("ST.SX", "SE2", "MR", "KNEE SAG", 2, SAGITTAL, 3);
        ingestSeries("ST.SX", "SE3", "CT", "HEAD", 3, AXIAL, 1);
    }

    private void ingestSeries(String study, String series, String modality, String desc, int seriesNo,
                              double[] iop, int n) throws Exception {
        for (int i = 0; i < n; i++) {
            Attributes a = DicomPhantomFactory.scImage("PID-SX", study, series, series + ".sop" + i);
            a.setString(Tag.Modality, VR.CS, modality);
            a.setString(Tag.SeriesDescription, VR.LO, desc);
            a.setString(Tag.SeriesNumber, VR.IS, String.valueOf(seriesNo));
            a.setString(Tag.SOPClassUID, VR.UI, UID.MRImageStorage); // 代表選択で SC 除外されないように
            a.setDouble(Tag.ImageOrientationPatient, VR.DS, iop);
            storage.ingest(DicomPhantomFactory.writeFile(
                    Files.createTempFile("phantom", ".dcm"), a, UID.ExplicitVRLittleEndian));
        }
    }

    private static SearchCondition include(String tag, String vr, String op, String v1, String v2) {
        return new SearchCondition(List.of(new Seg(tag, null)), vr, false, op, v1, v2, null);
    }
    private static SearchCondition exclude(String tag, String vr, String op, String v1) {
        return new SearchCondition(List.of(new Seg(tag, null)), vr, true, op, v1, null, null);
    }

    @Test
    void include_contains_string() {
        var r = service.verify(List.of("ST.SX"),
                List.of(include("0008103E", "LO", "CONTAINS", "KNEE", null)), null);
        assertEquals(2, r.seriesCount(), "KNEE を含むシリーズは 2");
    }

    @Test
    void include_contains_plus_planeAxial() {
        var r = service.verify(List.of("ST.SX"),
                List.of(include("0008103E", "LO", "CONTAINS", "KNEE", null)), List.of("AXIAL"));
        assertEquals(1, r.seriesCount(), "KNEE かつ AXIAL は SE1 のみ");
        assertEquals("SE1", r.matched().get(0).seriesUid());
    }

    @Test
    void include_numeric_ge() {
        var r = service.verify(List.of("ST.SX"),
                List.of(include("00200011", "IS", "GE", "2", null)), null);
        assertEquals(2, r.seriesCount(), "SeriesNumber>=2 は SE2,SE3");
    }

    @Test
    void include_numeric_ge_with_exclude_modality() {
        var r = service.verify(List.of("ST.SX"), List.of(
                include("00200011", "IS", "GE", "2", null),
                exclude("00080060", "CS", "EQUALS", "CT")), null);
        assertEquals(1, r.seriesCount(), "SeriesNumber>=2 かつ CT 除外 → SE2");
        assertEquals("SE2", r.matched().get(0).seriesUid());
    }

    @Test
    void copyToFolder_sequentialRename_and_mappingCsv() throws Exception {
        Path dest = Files.createTempDirectory("sx-dest-");
        var conds = List.of(include("0008103E", "LO", "CONTAINS", "KNEE", null));
        SeriesExtractService.CopyResult r = service.copyToFolder(
                List.of("ST.SX"), conds, null, dest.toString(), true);

        assertEquals(2, r.copiedSeries(), "KNEE 2 シリーズ");
        assertEquals(5, r.copiedFiles(), "SE1(2)+SE2(3)=5 ファイル");
        assertTrue(Files.isDirectory(dest.resolve("001")), "連番 001");
        assertTrue(Files.isDirectory(dest.resolve("002")), "連番 002");
        assertTrue(Files.exists(dest.resolve("mapping_table.csv")), "mapping_table.csv");
        long files = Files.list(dest.resolve("001")).filter(Files::isRegularFile).count()
                + Files.list(dest.resolve("002")).filter(Files::isRegularFile).count();
        assertEquals(5, files, "コピーされた DICOM ファイル総数");
    }

    // --- 混在・データシート・進捗・重複 ---

    private void ingestMixedSeries() throws Exception {
        // 先頭が SR（画素なし）、次が位置決め像、最後が通常の MR。代表は通常画像でなければならない。
        Attributes sr = DicomPhantomFactory.scImage("PID-MIX", "ST.MIX", "MX1", "MX1.sr");
        sr.setString(Tag.SOPClassUID, VR.UI, UID.BasicTextSRStorage);
        sr.setString(Tag.Modality, VR.CS, "SR");
        sr.setString(Tag.SeriesDescription, VR.LO, "WRONG-FROM-SR");
        sr.setString(Tag.InstanceNumber, VR.IS, "1");
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("phantom", ".dcm"), sr, UID.ExplicitVRLittleEndian));

        Attributes loc = DicomPhantomFactory.scImage("PID-MIX", "ST.MIX", "MX1", "MX1.loc");
        loc.setString(Tag.SOPClassUID, VR.UI, UID.MRImageStorage);
        loc.setString(Tag.ImageType, VR.CS, "DERIVED", "PRIMARY", "LOCALIZER");
        loc.setString(Tag.SeriesDescription, VR.LO, "WRONG-FROM-LOCALIZER");
        loc.setString(Tag.InstanceNumber, VR.IS, "2");
        loc.setDouble(Tag.ImageOrientationPatient, VR.DS, SAGITTAL);
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("phantom", ".dcm"), loc, UID.ExplicitVRLittleEndian));

        Attributes img = DicomPhantomFactory.scImage("PID-MIX", "ST.MIX", "MX1", "MX1.img");
        img.setString(Tag.SOPClassUID, VR.UI, UID.MRImageStorage);
        img.setString(Tag.Modality, VR.CS, "MR");
        img.setString(Tag.SeriesDescription, VR.LO, "REAL-IMAGE");
        img.setString(Tag.InstanceNumber, VR.IS, "3");
        img.setDouble(Tag.ImageOrientationPatient, VR.DS, AXIAL);
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("phantom", ".dcm"), img, UID.ExplicitVRLittleEndian));
    }

    @Test
    void mixedSeries_uses_plain_image_and_skips_sr_and_localizer() throws Exception {
        ingestMixedSeries();
        var hit = service.verify(List.of("ST.MIX"),
                List.of(include("0008103E", "LO", "EQUALS", "REAL-IMAGE", null)), List.of("AXIAL"));
        assertEquals(1, hit.seriesCount(), "SR・位置決め像を飛ばして通常画像の値で判定される");
        assertEquals(3, hit.matched().get(0).instances(), "枚数は 3 枚全部");
        assertEquals("AXIAL", hit.matched().get(0).plane());

        var miss = service.verify(List.of("ST.MIX"),
                List.of(include("0008103E", "LO", "CONTAINS", "WRONG", null)), null);
        assertEquals(0, miss.seriesCount(), "SR/位置決め像の値で一致してはいけない");
    }

    @Test
    void datasheet_has_required_columns_first_and_condition_values() throws Exception {
        var conds = List.of(include("0008103E", "LO", "CONTAINS", "KNEE", null),
                new SearchCondition(List.of(new Seg("00200011", null)), "IS", false, "GE", "1", null, "SeriesNo"));
        var vr = service.verify(List.of("ST.SX"), conds, null);
        String csv = SeriesExtractService.datasheetCsv(vr.matched(), conds);

        assertTrue(csv.startsWith("﻿"), "Excel 向けに BOM 付き");
        String[] lines = csv.substring(1).split("\r\n");
        String[] head = lines[0].split(",");
        assertEquals("PatientID", head[0]);
        assertEquals("StudyDate", head[1]);
        assertEquals("StudyInstanceUID", head[2]);
        assertEquals("SeriesInstanceUID", head[3]);
        assertEquals("SeriesNo", head[head.length - 1], "条件の列名は label");
        assertEquals(3, lines.length, "ヘッダ＋KNEE の 2 シリーズ");
        String[] row = lines[1].split(",");
        assertEquals("PID-SX", row[0]);
        assertEquals("20260101", row[1]);
        assertEquals("ST.SX", row[2]);
        assertEquals("SE1", row[3]);
        assertEquals("1", row[row.length - 1], "SeriesNumber の実測値");
    }

    @Test
    void verify_reports_monotonic_progress() {
        java.util.List<Integer> seen = new java.util.ArrayList<>();
        int[] total = {-1};
        service.verify(List.of("ST.SX"), List.of(), null, new SeriesExtractService.Progress() {
            public void total(int n) { total[0] = n; }
            public void advance(int p) { seen.add(p); }
            public boolean cancelled() { return false; }
        });
        assertEquals(3, total[0]);
        assertEquals(List.of(1, 2, 3), seen);
    }

    @Test
    void verify_can_be_cancelled() {
        org.junit.jupiter.api.Assertions.assertThrows(SeriesExtractService.CancelledException.class,
                () -> service.verify(List.of("ST.SX"), List.of(), null, new SeriesExtractService.Progress() {
                    public void total(int n) { }
                    public void advance(int p) { }
                    public boolean cancelled() { return true; }
                }));
    }

    @Test
    void duplicate_path_is_rejected_but_different_paths_are_not() {
        var a = include("0008103E", "LO", "CONTAINS", "KNEE", null);
        var same = include("0008103E", "LO", "EQUALS", "OTHER", null);
        var other = include("00080060", "CS", "EQUALS", "MR", null);
        var req = (java.util.function.Function<List<SearchCondition>, SeriesExtractController.ExtractReq>)
                cs -> new SeriesExtractController.ExtractReq(List.of("ST.SX"), cs, null, null, false, null, null);
        org.junit.jupiter.api.Assertions.assertThrows(org.springframework.web.server.ResponseStatusException.class,
                () -> SeriesExtractController.checkDuplicates(req.apply(List.of(a, same))));
        SeriesExtractController.checkDuplicates(req.apply(List.of(a, other)));
        // 同じタグでも creator が違う Private は別経路
        SeriesExtractController.checkDuplicates(req.apply(List.of(
                new SearchCondition(List.of(new Seg("00191001", "A")), "LO", false, "EQUALS", "x", null, null),
                new SearchCondition(List.of(new Seg("00191001", "B")), "LO", false, "EQUALS", "x", null, null))));
    }

    @Test
    void copy_writes_datasheet_into_destination() throws Exception {
        Path dest = Files.createTempDirectory("sx-dest-ds-");
        service.copyToFolder(List.of("ST.SX"), List.of(include("0008103E", "LO", "CONTAINS", "KNEE", null)),
                null, dest.toString(), false);
        assertTrue(Files.exists(dest.resolve("series_datasheet.csv")));
        assertTrue(Files.exists(dest.resolve("extracted_series_list.csv")), "連番オフは一覧 CSV");
        assertTrue(Files.readString(dest.resolve("series_datasheet.csv")).contains("SE2"));
    }
}
