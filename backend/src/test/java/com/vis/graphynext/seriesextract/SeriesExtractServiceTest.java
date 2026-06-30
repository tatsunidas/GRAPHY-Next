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
        return new SearchCondition(List.of(new Seg(tag, null)), vr, false, op, v1, v2);
    }
    private static SearchCondition exclude(String tag, String vr, String op, String v1) {
        return new SearchCondition(List.of(new Seg(tag, null)), vr, true, op, v1, null);
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
}
