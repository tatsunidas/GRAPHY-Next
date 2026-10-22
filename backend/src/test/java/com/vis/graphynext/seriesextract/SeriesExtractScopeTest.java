/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.StudySearch;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 大規模 DB 向けの対象指定（絞り込み条件のサーバー解決・規模の問い合わせ）と、探索の性質
 * （チャンク・並列でも順序が変わらない・途中で止まる・検証済みの一覧を再探索せずに使う）を検証する。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:seriesextractscope;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
@ActiveProfiles("standalone")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SeriesExtractScopeTest {

    // PER_CLASS では @TempDir の注入が文脈の生成に間に合わないので、自分で作る。
    static final Path tmp = newTemp();

    private static Path newTemp() {
        try {
            return Files.createTempDirectory("sx-scope-");
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;
    @Autowired
    SeriesExtractService service;
    @Autowired
    SeriesExtractJobService jobs;

    static final double[] AXIAL = {1, 0, 0, 0, 1, 0};

    private final AtomicInteger sopSeq = new AtomicInteger();

    private void ingest(String patient, String study, String date, String modality, String series, int seriesNo,
                        int n) throws Exception {
        for (int i = 0; i < n; i++) {
            Attributes a = DicomPhantomFactory.scImage(patient, study, series, series + ".sop" + sopSeq.incrementAndGet());
            a.setString(Tag.Modality, VR.CS, modality);
            a.setString(Tag.StudyDate, VR.DA, date);
            a.setString(Tag.SeriesDescription, VR.LO, "S" + seriesNo);
            a.setString(Tag.SeriesNumber, VR.IS, String.valueOf(seriesNo));
            a.setString(Tag.SOPClassUID, VR.UI, UID.MRImageStorage);
            a.setDouble(Tag.ImageOrientationPatient, VR.DS, AXIAL);
            storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("phantom", ".dcm"), a,
                    UID.ExplicitVRLittleEndian));
        }
    }

    @BeforeAll
    void seed() throws Exception {
        // P1: 2 スタディ（CT 20250101・MR 20250201）、P2: 1 スタディ（CT 20260101）
        ingest("P1", "ST.A", "20250101", "CT", "A1", 1, 2);
        ingest("P1", "ST.A", "20250101", "CT", "A2", 2, 1);
        ingest("P1", "ST.B", "20250201", "MR", "B1", 1, 3);
        ingest("P2", "ST.C", "20260101", "CT", "C1", 1, 1);
        // 窓（32）をまたぐ 40 シリーズのスタディ。番号は逆順に取り込み、並びが SeriesNumber 順になることを見る。
        for (int k = 40; k >= 1; k--) {
            ingest("P3", "ST.BIG", "20240101", "MR", "BIG" + k, k, 1);
        }
    }

    private static StudySearch filters(String pid, String from, String to, String mod) {
        return new StudySearch(pid, null, from, to, mod, null);
    }

    private List<String> resolve(StudySearch f) {
        return service.resolveStudies(new SeriesExtractService.ScopeReq(null, f));
    }

    @Test
    void filters_are_resolved_on_the_server() {
        assertEquals(java.util.Set.of("ST.A", "ST.B"), new java.util.HashSet<>(resolve(filters("P1", null, null, null))));
        assertEquals(List.of("ST.C"), resolve(filters("P2", null, null, null)));
        assertEquals(java.util.Set.of("ST.B", "ST.BIG"), new java.util.HashSet<>(resolve(filters(null, null, null, "MR"))));
        assertEquals(List.of("ST.C"), resolve(filters(null, "20260101", "20261231", null)));
        assertTrue(resolve(filters("NOBODY", null, null, null)).isEmpty(), "負例: 該当なしは空");
        assertTrue(resolve(filters("P2", null, null, "MR")).isEmpty(), "負例: 患者とモダリティが食い違えば空");
    }

    @Test
    void explicit_uids_take_precedence_over_filters() {
        var r = service.resolveStudies(new SeriesExtractService.ScopeReq(List.of("ST.A"), filters("P2", null, null, null)));
        assertEquals(List.of("ST.A"), r);
        assertThrows(IllegalArgumentException.class,
                () -> service.resolveStudies(new SeriesExtractService.ScopeReq(null, null)));
    }

    @Test
    void scope_counts_match_the_seed() {
        var p1 = service.scope(new SeriesExtractService.ScopeReq(null, filters("P1", null, null, null)));
        assertEquals(2, p1.studies());
        assertEquals(3, p1.series());
        assertEquals(6, p1.instances());
        var big = service.scope(new SeriesExtractService.ScopeReq(List.of("ST.BIG"), null));
        assertEquals(1, big.studies());
        assertEquals(40, big.series());
        assertEquals(40, big.instances());
    }

    @Test
    void chunk_boundary_does_not_lose_or_reorder_series() {
        // 500 件のチャンクをまたぐよう、存在しない UID を大量に挟む。実在 3 スタディの 4 + ... シリーズは欠けない。
        List<String> uids = new ArrayList<>();
        for (int i = 0; i < 700; i++) {
            uids.add("NOPE." + i);
        }
        uids.add(0, "ST.C");
        uids.add(450, "ST.A");
        uids.add("ST.B");
        var s = service.scope(new SeriesExtractService.ScopeReq(uids, null));
        assertEquals(4, s.series(), "C1 + A1,A2 + B1");
        var r = service.verify(uids, List.of(), null);
        assertEquals(List.of("C1", "A1", "A2", "B1"), r.matched().stream().map(SeriesExtractService.SeriesMatch::seriesUid).toList(),
                "渡したスタディの順、スタディ内はシリーズ番号順");
    }

    @Test
    void parallel_reading_keeps_series_order_across_windows() {
        var r = service.verify(List.of("ST.BIG"), List.of(), null);
        assertEquals(40, r.seriesCount());
        List<Integer> nums = r.matched().stream().map(m -> Integer.parseInt(m.seriesNumber())).toList();
        List<Integer> sorted = nums.stream().sorted().toList();
        assertEquals(sorted, nums, "32 件の窓をまたいでも並びが SeriesNumber 順のまま");
    }

    @Test
    void cancel_stops_between_windows() {
        int[] advanced = {0};
        boolean[] cancel = {false};
        assertThrows(SeriesExtractService.CancelledException.class, () -> service.verify(List.of("ST.BIG"), List.of(), null,
                new SeriesExtractService.Progress() {
                    public void total(int n) { }
                    public void advance(int p) { advanced[0] = p; cancel[0] = true; }
                    public boolean cancelled() { return cancel[0]; }
                }));
        assertTrue(advanced[0] >= 1 && advanced[0] < 40, "最後まで走らずに止まる: " + advanced[0]);
    }

    private SeriesExtractJobService.Status await(String id) throws Exception {
        for (int i = 0; i < 600; i++) {
            var st = jobs.get(id);
            if (st.state() == SeriesExtractJobService.State.DONE || st.state() == SeriesExtractJobService.State.FAILED
                    || st.state() == SeriesExtractJobService.State.CANCELLED) {
                return st;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("ジョブが終わらない");
    }

    @Test
    void verified_result_is_reused_without_rescanning() throws Exception {
        var cond = new SearchCondition(List.of(new com.vis.graphynext.extract.TagExtractService.Seg("0008103E", null)),
                "LO", false, "EQUALS", "S1", null, null);
        var v = await(jobs.submitVerify(List.of("ST.A", "ST.B", "ST.BIG", "ST.LATE"), List.of(cond), null).jobId());
        assertEquals(SeriesExtractJobService.State.DONE, v.state());
        assertEquals(3, v.verify().seriesCount(), "A1・B1・BIG1");

        // 検証のあとに、同じ条件に合う新しいシリーズを足す。再探索するならコピーに含まれてしまう。
        ingest("P4", "ST.LATE", "20230101", "CT", "L1", 1, 1);
        Path dest = Files.createTempDirectory("sx-reuse-");
        var c = await(jobs.submitCopyVerified(v.jobId(), dest.toString(), false).jobId());
        assertEquals(SeriesExtractJobService.State.DONE, c.state());
        assertEquals(3, c.copy().copiedSeries(), "検証済みの 3 件だけ。後から足した L1 は含まれない（＝再探索していない）");

        // 負例: 再探索する経路は、後から足した分も拾う（テストの前提が効いていることの確認）。
        var rescanned = service.verify(List.of("ST.A", "ST.B", "ST.BIG", "ST.LATE"), List.of(cond), null);
        assertEquals(4, rescanned.seriesCount());

        String csv = jobs.datasheet(v.jobId());
        assertEquals(1 + 3, csv.substring(1).split("\r\n").length, "ヘッダ＋検証済みの 3 行");
        assertTrue(csv.contains("A1") && !csv.contains("L1"));
    }

    @Test
    void stale_or_unknown_verify_job_is_rejected() {
        assertThrows(SeriesExtractJobService.StaleJobException.class, () -> jobs.datasheet("no-such-job"));
        assertThrows(SeriesExtractJobService.StaleJobException.class,
                () -> jobs.submitCopyVerified("no-such-job", tmp.toString(), true));
        assertThrows(SeriesExtractJobService.StaleJobException.class, () -> jobs.verified(null));
    }

    @Test
    void candidates_prefer_image_sop_class_without_loading_the_whole_series() {
        assertFalse(SeriesExtractService.isNonImageSop("1.2.840.10008.5.1.4.1.1.77.1.4"),
                "可視光画像（…1.1.77）を SC（…1.1.7）と取り違えない");
        assertTrue(SeriesExtractService.isNonImageSop("1.2.840.10008.5.1.4.1.1.7"));
        assertTrue(SeriesExtractService.isNonImageSop("1.2.840.10008.5.1.4.1.1.7.2"));
        assertTrue(SeriesExtractService.isNonImageSop("1.2.840.10008.5.1.4.1.1.88.11"));
        assertFalse(SeriesExtractService.isNonImageSop("1.2.840.10008.5.1.4.1.1.4"), "MR");
    }
}
