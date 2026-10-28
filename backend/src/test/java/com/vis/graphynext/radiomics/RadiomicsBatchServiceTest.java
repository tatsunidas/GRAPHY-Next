/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.cache.CacheStore;
import com.vis.graphynext.radiomics.RadiomicsBatchService.FailureKind;
import com.vis.graphynext.radiomics.RadiomicsBatchService.JobState;
import com.vis.graphynext.radiomics.RadiomicsBatchService.PairState;
import com.vis.graphynext.radiomics.RadiomicsBatchService.Status;
import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RadiomicsBatchServiceTest {

    private static final int W = 16, H = 16, D = 6;
    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    private static BatchPair pair(int i, BatchPair.Status status) {
        boolean auto = status == BatchPair.Status.AUTO;
        return new BatchPair("1.2", auto ? "src" + i : null, "seg" + i, 1, "s", 0, status,
                status == BatchPair.Status.EXCLUDED ? "マスクが空" : null, List.of());
    }

    private static BatchPair auto(int i) {
        return pair(i, BatchPair.Status.AUTO);
    }

    private static RadiomicsBatchService.BatchRequest request(List<BatchPair> pairs) {
        return new RadiomicsBatchService.BatchRequest(pairs, new HashMap<>(), null, null, null, null, null, null, 0,
                0, false);
    }

    private static RadiomicsBatchService service(RadiomicsBatchService.Computer c) {
        return new RadiomicsBatchService(c, req -> { }, null, null);
    }

    private static Status await(RadiomicsBatchService svc, Status first) throws InterruptedException {
        return await(svc, first, 60_000);
    }

    private static Status await(RadiomicsBatchService svc, Status first, long limitMs) throws InterruptedException {
        long end = System.currentTimeMillis() + limitMs;
        Status s = first;
        while (System.currentTimeMillis() < end) {
            s = svc.get(first.jobId());
            if (s.state() != JobState.QUEUED && s.state() != JobState.RUNNING) {
                return s;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("ジョブが終わらない: " + s.state());
    }

    private static RoiFeatureResult stub(boolean fromCache) {
        return new RoiFeatureResult("rj", java.time.Instant.EPOCH, fromCache, 1, List.of(), null, null, null, null,
                false);
    }

    @Test
    void emptyMaskPairsAreNeverComputed_andEveryPairIsAccountedFor() throws Exception {
        AtomicInteger computed = new AtomicInteger();
        RadiomicsBatchService svc = service((req, c) -> {
            computed.incrementAndGet();
            return stub(false);
        });
        List<BatchPair> pairs = new ArrayList<>();
        for (int i = 0; i < 17; i++) pairs.add(auto(i));
        pairs.add(pair(17, BatchPair.Status.EXCLUDED));
        pairs.add(pair(18, BatchPair.Status.EXCLUDED));

        Status s = await(svc, svc.submit(request(pairs)));

        assertEquals(JobState.DONE, s.state());
        assertEquals(19, s.total());
        assertEquals(17, s.done());
        assertEquals(2, s.skipped());
        assertEquals(0, s.failed());
        assertEquals(17, computed.get(), "空のマスクの組は compute を呼ばない（呼ぶと全面マスクで誤った値が出る）");
        assertEquals(17, svc.results(s.jobId()).size());
    }

    @Test
    void pairWithoutConfirmedSourceIsRejectedAtSubmit() {
        RadiomicsBatchService svc = service((req, c) -> stub(false));
        BatchPair unconfirmed = pair(1, BatchPair.Status.NEEDS_CONFIRMATION);
        assertThrows(IllegalArgumentException.class, () -> svc.submit(request(List.of(auto(0), unconfirmed))));
        assertThrows(IllegalArgumentException.class, () -> svc.submit(request(List.of())));
    }

    @Test
    void confirmedPairIsComputedWithTheChosenSource() throws Exception {
        List<String> seen = new ArrayList<>();
        RadiomicsBatchService svc = service((req, c) -> {
            seen.add(req.sourceSeriesUid() + "/" + req.maskSeriesUid() + "/" + req.maskChannel());
            return stub(false);
        });
        BatchPair chosen = new BatchPair("1.2", "CT", "seg1", 3, "s", 2, BatchPair.Status.NEEDS_CONFIRMATION, null,
                List.of("CT", "MR"));
        Status s = await(svc, svc.submit(request(List.of(chosen))));
        assertEquals(1, s.done());
        assertEquals(List.of("CT/seg1/2"), seen);
    }

    @Test
    void checkerFailureRejectsTheWholeSubmit() {
        RadiomicsBatchService svc = new RadiomicsBatchService((req, c) -> stub(false), req -> {
            throw new IllegalStateException("standalone 専用");
        }, null, null);
        assertThrows(IllegalStateException.class, () -> svc.submit(request(List.of(auto(0)))));
    }

    @Test
    void inputAndEngineFailuresAreRecordedPerPair_andTheRestContinues() throws Exception {
        RadiomicsBatchService svc = service((req, c) -> {
            if (req.sourceSeriesUid().equals("src1")) throw new IllegalArgumentException("ROI が空です");
            if (req.sourceSeriesUid().equals("src2")) throw new IllegalStateException("計算に失敗しました");
            return stub(false);
        });
        Status s = await(svc, svc.submit(request(List.of(auto(0), auto(1), auto(2), auto(3)))));

        assertEquals(JobState.DONE, s.state());
        assertEquals(2, s.done());
        assertEquals(2, s.failed());
        assertEquals(FailureKind.INPUT, s.pairs().get(1).failureKind());
        assertEquals(FailureKind.ENGINE, s.pairs().get(2).failureKind());
        assertEquals("ROI が空です", s.pairs().get(1).error());
        assertEquals(PairState.DONE, s.pairs().get(3).state());
    }

    @Test
    void environmentFailureStopsTheJob_andNeverRewritesPairsAsFailed() throws Exception {
        RadiomicsBatchService svc = service((req, c) -> {
            if (req.sourceSeriesUid().equals("src2")) throw new IOException("disk full");
            return stub(false);
        });
        Status s = await(svc, svc.submit(request(List.of(auto(0), auto(1), auto(2), auto(3), auto(4)))));

        assertEquals(JobState.STOPPED, s.state());
        assertEquals("disk full", s.stopReason());
        assertEquals(2, s.done());
        assertEquals(0, s.failed(), "環境の障害は組の失敗に書き換えない");
        assertEquals(3, s.notRun());
        assertEquals(FailureKind.ENVIRONMENT, s.pairs().get(2).failureKind());
    }

    @Test
    void outOfMemoryAlsoStopsTheJob() throws Exception {
        RadiomicsBatchService svc = service((req, c) -> {
            if (req.sourceSeriesUid().equals("src1")) throw new OutOfMemoryError("heap");
            return stub(false);
        });
        Status s = await(svc, svc.submit(request(List.of(auto(0), auto(1), auto(2)))));
        assertEquals(JobState.STOPPED, s.state());
        assertEquals(0, s.failed());
        assertEquals(2, s.notRun());
    }

    @Test
    void cancelStopsBeforeTheNextPair_andTheRunningPairFinishes() throws Exception {
        AtomicReference<RadiomicsBatchService> self = new AtomicReference<>();
        AtomicReference<String> jobId = new AtomicReference<>();
        AtomicInteger computed = new AtomicInteger();
        RadiomicsBatchService svc = service((req, c) -> {
            if (computed.incrementAndGet() == 2) {
                while (jobId.get() == null) Thread.onSpinWait();
                self.get().cancel(jobId.get());
            }
            return stub(false);
        });
        self.set(svc);
        Status first = svc.submit(request(List.of(auto(0), auto(1), auto(2), auto(3))));
        jobId.set(first.jobId());
        Status s = await(svc, first);

        assertEquals(JobState.CANCELLED, s.state());
        assertEquals(2, computed.get());
        assertEquals(2, s.done(), "走り出した 1 組は終わる");
        assertEquals(2, s.cancelled());
    }

    @Test
    void cancellationExceptionFromTheComputeMarksThePairCancelled() throws Exception {
        RadiomicsBatchService svc = service((req, c) -> {
            throw new CancellationException();
        });
        Status s = await(svc, svc.submit(request(List.of(auto(0)))));
        assertEquals(PairState.CANCELLED, s.pairs().get(0).state());
    }

    // ---- 実物の RoiFeatureService（RadiomicsJ）を通す ----

    private static ImagePlus phantom(long seed) {
        ImageStack st = new ImageStack(W, H);
        long s = seed;
        for (int z = 0; z < D; z++) {
            FloatProcessor ip = new FloatProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                s = s * 6364136223846793005L + 1442695040888963407L;
                ip.setf(x, y, (int) Math.floorMod(s >> 33, 400) + 3 * z);
            }
            st.addSlice(ip);
        }
        ImagePlus imp = new ImagePlus("p", st);
        Calibration c = imp.getCalibration();
        c.pixelWidth = 0.8; c.pixelHeight = 0.8; c.pixelDepth = 1.5;
        return imp;
    }

    private static ImagePlus mask() {
        ImageStack st = new ImageStack(W, H);
        for (int z = 0; z < D; z++) {
            ByteProcessor ip = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                ip.set(x, y, (x >= 3 && x < 12 && y >= 4 && y < 13 && z >= 1 && z < D - 1) ? 1 : 0);
            }
            st.addSlice(ip);
        }
        return new ImagePlus("m", st);
    }

    /** 元画像シリーズごとに別の画像を返すエンジン。 */
    private static final class PairEngine extends RadiomicsMapEngine {
        PairEngine() {
            super(null, new MapCheckpointStore(new CacheStore(Path.of("unused"), 0), null), null);
        }

        @Override
        public LoadedVolume load(String study, String series, int channel, int timePoint, String maskSeries,
                                 int maskChannel, int label, Map<String, String> settings) {
            ImagePlus img = phantom(1000L + series.hashCode());
            String[] sops = new String[D];
            for (int z = 0; z < D; z++) sops[z] = "1.2.3." + z;
            return new LoadedVolume(img, mask(), W, H, D, 1, true, img.getCalibration(), null, 0.8, 0.8,
                    new HashMap<>(), sops, null, null, false);
        }
    }

    private final AtomicInteger extractions = new AtomicInteger();

    private RoiFeatureService realFeatures(Path dir) {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("standalone");
        return new RoiFeatureService(new PairEngine(), new MapCheckpointStore(new CacheStore(dir, 0), "v"),
                new RadiomicsMode(env), JSON, (rj, img, m, label) -> {
                    extractions.incrementAndGet();
                    return rj.extractAll(img, m, label);
                }, "9.9.9-test", () -> null);
    }

    private static Map<String, String> firstOrderOnly() {
        Map<String, String> m = new HashMap<>();
        m.put("INT_binCount", "16");
        return m;
    }

    @Test
    void batchValuesEqualTheDirectComputeOfTheSamePair_andRerunResumesFromTheCache(@TempDir Path dir)
            throws Exception {
        RoiFeatureService features = realFeatures(dir);
        RadiomicsBatchService svc = new RadiomicsBatchService(
                (req, c) -> features.compute(req, p -> { }, (d, t) -> { }, c), features::check, null, null);
        List<BatchPair> pairs = List.of(auto(0), auto(1), auto(2));
        RadiomicsBatchService.BatchRequest req = new RadiomicsBatchService.BatchRequest(pairs, firstOrderOnly(), null,
                null, null, null, null, null, 0, 0, false);

        Status s1 = await(svc, svc.submit(req));
        assertEquals(3, s1.done());
        assertEquals(3, extractions.get());

        // 同じ 1 組を、バッチを通さずに直接計算した値と一致する（キャッシュを使わず recompute で）
        RoiFeatureRequest direct = new RoiFeatureRequest("1.2", "src1", "seg1", 0, 0, 0, firstOrderOnly(), true);
        RoiFeatureResult viaDirect = features.compute(direct, p -> { });
        RoiFeatureResult viaBatch = svc.results(s1.jobId()).get(1).result();
        assertEquals(viaDirect.rows().size(), viaBatch.rows().size());
        for (int i = 0; i < viaDirect.rows().size(); i++) {
            assertEquals(viaDirect.rows().get(i).column(), viaBatch.rows().get(i).column());
            assertEquals(viaDirect.rows().get(i).value(), viaBatch.rows().get(i).value(),
                    viaDirect.rows().get(i).column());
        }

        // 同じ要求の再実行は計算し直さない（続きから進む＝計算済みの組はキャッシュに当たる）
        int before = extractions.get();
        Status s2 = await(svc, svc.submit(req));
        assertEquals(3, s2.done());
        assertEquals(before, extractions.get(), "再実行で抽出器が呼ばれていない");
        assertTrue(s2.pairs().stream().allMatch(p -> p.fromCache()));
        assertFalse(s1.pairs().stream().anyMatch(p -> p.fromCache()));
    }

    @Test
    void differentPairsGiveDifferentValues(@TempDir Path dir) throws Exception {
        // 取り違え検出の負例: 元画像が違えば値も違う（違いが出ないなら上の一致の検査は意味を持たない）
        RoiFeatureService features = realFeatures(dir);
        RadiomicsBatchService svc = new RadiomicsBatchService(
                (req, c) -> features.compute(req, p -> { }, (d, t) -> { }, c), features::check, null, null);
        Status s = await(svc, svc.submit(new RadiomicsBatchService.BatchRequest(List.of(auto(0), auto(1)),
                firstOrderOnly(), null, null, null, null, null, null, 0, 0, false)));
        List<RadiomicsBatchService.PairResult> r = svc.results(s.jobId());
        assertEquals(2, r.size());
        boolean anyDiffers = false;
        for (int i = 0; i < r.get(0).result().rows().size(); i++) {
            Double a = r.get(0).result().rows().get(i).value();
            Double b = r.get(1).result().rows().get(i).value();
            if (a != null && b != null && !a.equals(b)) anyDiffers = true;
        }
        assertTrue(anyDiffers);
    }

    /**
     * 実測用（通常は走らせない）: {@code -Dbatch.measure=true} のときだけ、64×64×32 の合成 20 組を実際に計算して
     * 1 組あたりの時間とキャッシュの大きさを標準出力に出す。
     */
    @Test
    @org.junit.jupiter.api.condition.EnabledIfSystemProperty(named = "batch.measure", matches = "true")
    void measureTwentyRealPairs(@TempDir Path dir) throws Exception {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("standalone");
        int n = 64, d = 32;
        RadiomicsMapEngine engine = new RadiomicsMapEngine(null,
                new MapCheckpointStore(new CacheStore(Path.of("unused"), 0), null), null) {
            @Override
            public LoadedVolume load(String study, String series, int channel, int timePoint, String maskSeries,
                                     int maskChannel, int label, Map<String, String> settings) {
                ImageStack st = new ImageStack(n, n);
                ImageStack ms = new ImageStack(n, n);
                long s = 1000L + series.hashCode();
                for (int z = 0; z < d; z++) {
                    FloatProcessor ip = new FloatProcessor(n, n);
                    ByteProcessor mp = new ByteProcessor(n, n);
                    for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) {
                        s = s * 6364136223846793005L + 1442695040888963407L;
                        ip.setf(x, y, (int) Math.floorMod(s >> 33, 400) + 3 * z);
                        mp.set(x, y, (x >= 16 && x < 48 && y >= 16 && y < 48 && z >= 8 && z < 24) ? 1 : 0);
                    }
                    st.addSlice(ip);
                    ms.addSlice(mp);
                }
                ImagePlus img = new ImagePlus("p", st);
                Calibration c = img.getCalibration();
                c.pixelWidth = 0.8; c.pixelHeight = 0.8; c.pixelDepth = 1.5;
                String[] sops = new String[d];
                for (int z = 0; z < d; z++) sops[z] = "1.2.3." + z;
                return new LoadedVolume(img, new ImagePlus("m", ms), n, n, d, 1, true, c, null, 0.8, 0.8,
                        new HashMap<>(), sops, null, null, false);
            }
        };
        RoiFeatureService features = new RoiFeatureService(engine, new MapCheckpointStore(new CacheStore(dir, 0), "v"),
                new RadiomicsMode(env), JSON, (rj, img, m, label) -> rj.extractAll(img, m, label), "9.9.9-test",
                () -> null);
        RadiomicsBatchService svc = new RadiomicsBatchService(
                (req, c) -> features.compute(req, p -> { }, (a, b) -> { }, c), features::check, null, null);
        List<BatchPair> pairs = new ArrayList<>();
        for (int i = 0; i < 20; i++) pairs.add(auto(i));
        long t0 = System.currentTimeMillis();
        Status s = await(svc, svc.submit(request(pairs)), 25 * 60_000);
        long total = System.currentTimeMillis() - t0;
        long bytes;
        try (var w = java.nio.file.Files.walk(dir)) {
            bytes = w.filter(java.nio.file.Files::isRegularFile).mapToLong(p -> p.toFile().length()).sum();
        }
        long[] ms = s.pairs().stream().mapToLong(RadiomicsBatchService.PairStatus::elapsedMs).sorted().toArray();
        System.out.println("MEASURE pairs=20 volume=" + n + "x" + n + "x" + d + " roiVoxels=" + (32 * 32 * 16)
                + " done=" + s.done() + " failed=" + s.failed() + " totalMs=" + total + " medianPairMs="
                + ms[ms.length / 2] + " maxPairMs=" + ms[ms.length - 1] + " cacheBytesTotal=" + bytes
                + " cacheBytesPerPair=" + bytes / 20);
        assertEquals(20, s.done());
    }
}
