/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
import com.vis.graphynext.dicom.store.DicomStoreScu;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.junit.jupiter.api.io.TempDir;

import java.net.ServerSocket;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ローカル保管庫（FS + H2 索引）と C-STORE 受信のエンドツーエンド検証。
 * H2 はインメモリ、保管庫は一時ディレクトリに差し替える。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:storeit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DicomStoreIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;

    @Test
    void ingest_isIdempotent_and_indexed_with_fileUri() throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("PID1", "1.2.study.1", "1.2.series.1", "1.2.sop.1");

        // 同じインスタンスを 2 回取り込む（冪等のはず）
        storage.ingest(writePhantom(ds));
        storage.ingest(writePhantom(ds));

        List<DicomInstance> byStudy = storage.findMatches(null, "1.2.study.1", null, null);
        assertEquals(1, byStudy.size(), "再受信しても索引は 1 行（冪等）");

        DicomInstance inst = byStudy.get(0);
        assertTrue(inst.getUri().startsWith("file:"), "URI は file: スキーム");
        assertTrue(Files.exists(Path.of(URI.create(inst.getUri()))), "FS にファイルが存在する");

        // マッチングの各レベル
        assertEquals(1, storage.findMatches("PID1", null, null, null).size());
        assertEquals(1, storage.findMatches(null, null, "1.2.series.1", null).size());
        assertEquals(1, storage.findMatches(null, null, null, "1.2.sop.1").size());
        assertEquals(0, storage.findMatches(null, "no.such.study", null, null).size());
    }

    @Test
    void cStore_endToEnd_storesAndIndexes() throws Exception {
        int port = freePort();
        DicomScpServer scp = new DicomScpServer("GRAPHYSTORE", "127.0.0.1", port);
        scp.addService(
                new DicomStoreScp(storage, tmp.resolve("scp-incoming")),
                new TransferCapability(null, "*", TransferCapability.Role.SCP, "*"));
        scp.start();
        try {
            Attributes ds = DicomPhantomFactory.scImage("PID2", "1.2.study.2", "1.2.series.2", "1.2.sop.2");
            Path file = writePhantom(ds);

            DicomStoreScu.StoreResult r =
                    new DicomStoreScu().store("127.0.0.1", port, "GRAPHYSTORE", "SCU", file);

            assertTrue(r.success(), () -> "C-STORE should succeed: " + r.message());
            List<DicomInstance> m = storage.findMatches(null, "1.2.study.2", null, null);
            assertEquals(1, m.size(), "受信したインスタンスが索引に載る");
        } finally {
            scp.stop();
        }
    }

    @Test
    void listStudies_groupsInstancesByStudy() throws Exception {
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PA", "ST.A", "SE.A", "SOP.A1")));
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PA", "ST.A", "SE.A", "SOP.A2")));
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PB", "ST.B", "SE.B", "SOP.B1")));

        var studies = storage.listStudies();
        var a = studies.stream().filter(s -> "ST.A".equals(s.studyInstanceUid())).findFirst().orElseThrow();
        assertEquals(2, a.numberOfInstances(), "ST.A はインスタンス2件");
        assertEquals("PA", a.patientId());
        assertTrue(studies.stream().anyMatch(s -> "ST.B".equals(s.studyInstanceUid())), "ST.B も一覧に出る");
    }

    @Test
    void listSeries_and_listInstances() throws Exception {
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PC", "ST.C", "SE.C1", "SOP.C1a")));
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PC", "ST.C", "SE.C1", "SOP.C1b")));
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PC", "ST.C", "SE.C2", "SOP.C2a")));

        var series = storage.listSeries("ST.C");
        assertEquals(2, series.size(), "ST.C は 2 シリーズ");
        var c1 = series.stream().filter(s -> "SE.C1".equals(s.seriesInstanceUid())).findFirst().orElseThrow();
        assertEquals(2, c1.numberOfInstances(), "SE.C1 はインスタンス 2 件");

        var instances = storage.listInstances("ST.C", "SE.C1");
        assertEquals(2, instances.size(), "SE.C1 のインスタンス一覧は 2 件");
    }

    @Test
    void listStudies_filtersByDateRangeAndModalities() throws Exception {
        // 同一 H2 を他テストと共有するため、固有の患者名で自テストのデータだけを絞り込む。
        storage.ingest(writePhantom(study("ST.D1", "20260101", "OT")));
        storage.ingest(writePhantom(study("ST.D2", "20260615", "CT")));
        storage.ingest(writePhantom(study("ST.D3", "20260620", "MR")));
        String name = "RANGECASE";

        // 日付レンジ: 20260610〜20260630 は D2,D3 のみ（D1=20260101 は範囲外）
        var inRange = storage.listStudies(new StudySearch(null, name, "20260610", "20260630", null, null));
        assertEquals(2, inRange.size(), "範囲内は 2 件");
        assertTrue(inRange.stream().noneMatch(s -> "ST.D1".equals(s.studyInstanceUid())), "D1 は範囲外");

        // 開始のみ（…以降）
        assertEquals(2, storage.listStudies(new StudySearch(null, name, "20260610", null, null, null)).size());
        // 終了のみ（…以前）→ D1 のみ
        var beforeJun = storage.listStudies(new StudySearch(null, name, null, "20260101", null, null));
        assertEquals(1, beforeJun.size());
        assertEquals("ST.D1", beforeJun.get(0).studyInstanceUid());

        // モダリティ単一
        var ct = storage.listStudies(new StudySearch(null, name, null, null, "CT", null));
        assertEquals(1, ct.size());
        assertEquals("ST.D2", ct.get(0).studyInstanceUid());

        // モダリティ複数（カンマ区切り）→ CT,MR の 2 件
        assertEquals(2, storage.listStudies(new StudySearch(null, name, null, null, "CT,MR", null)).size());
        // 空白混じりでも正規化される
        assertEquals(2, storage.listStudies(new StudySearch(null, name, null, null, " CT , MR ", null)).size());

        // 患者名の部分一致（自テストの 3 件）
        assertEquals(3, storage.listStudies(new StudySearch(null, name, null, null, null, null)).size());
    }

    @Test
    void resolveInstanceFile_returnsExistingPath_orNull() throws Exception {
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PF", "ST.F", "SE.F", "SOP.F1")));

        Path p = storage.resolveInstanceFile("SOP.F1");
        assertTrue(p != null && Files.exists(p), "取り込んだ SOP のローカルファイルが解決できる");
        assertEquals(null, storage.resolveInstanceFile("SOP.NOPE"), "未知の SOP は null");
    }

    /** scImage を作って固有の患者名・StudyDate・Modality を設定する。 */
    private static Attributes study(String studyUid, String studyDate, String modality) {
        Attributes a = DicomPhantomFactory.scImage(studyUid + ".pid", studyUid, studyUid + ".se", studyUid + ".sop");
        a.setString(Tag.PatientName, VR.PN, "RANGECASE^X");
        a.setString(Tag.StudyDate, VR.DA, studyDate);
        a.setString(Tag.Modality, VR.CS, modality);
        return a;
    }

    private static Path writePhantom(Attributes ds) throws Exception {
        Path f = Files.createTempFile("phantom", ".dcm");
        return DicomPhantomFactory.writeFile(f, ds, UID.ExplicitVRLittleEndian);
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException("free port を確保できませんでした", e);
        }
    }
}
