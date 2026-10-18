/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.cache.CacheStore;
import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.measure.ResultsTable;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/** ROI 特徴量表: 設定の扱い・定義の注記・キャッシュ・取り消し・共通ロック。 */
class RoiFeatureServiceTest {

    private static final int W = 16, H = 16, D = 6;

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    private static ImagePlus phantom() {
        ImageStack st = new ImageStack(W, H);
        long s = 777L;
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

    private static ImagePlus mask(int extraX) {
        ImageStack st = new ImageStack(W, H);
        for (int z = 0; z < D; z++) {
            ByteProcessor ip = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                ip.set(x, y, (x >= 3 && x < 12 + extraX && y >= 4 && y < 13 && z >= 1 && z < D - 1) ? 1 : 0);
            }
            st.addSlice(ip);
        }
        return new ImagePlus("m", st);
    }

    private static RadiomicsMapEngine.LoadedVolume volume(ImagePlus img, ImagePlus mask) {
        String[] sops = new String[D];
        for (int z = 0; z < D; z++) sops[z] = "1.2.3." + z;
        // 実際の読み込みと同じく、マスクには校正を付けない
        return new RadiomicsMapEngine.LoadedVolume(img, mask, W, H, D, 1, true, img.getCalibration(),
                null, 0.8, 0.8, new HashMap<>(), sops, null, null);
    }

    /** 読み込みの代わりに、決めたボリュームを返すエンジン。 */
    private static final class FixedEngine extends RadiomicsMapEngine {
        volatile LoadedVolume vol;

        FixedEngine(LoadedVolume vol) {
            super(null, new MapCheckpointStore(new CacheStore(Path.of("unused"), 0), null));
            this.vol = vol;
        }

        @Override
        public LoadedVolume load(String study, String series, int channel, int timePoint, String maskSeries,
                                 int maskChannel, int label, Map<String, String> settings) {
            assertTrue(settings.isEmpty(), "Next のテクスチャ設定は渡さない");
            return vol;
        }
    }

    private static RadiomicsMode standalone() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("standalone");
        return new RadiomicsMode(env);
    }

    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();

    private final AtomicInteger extractions = new AtomicInteger();

    private RoiFeatureService service(FixedEngine engine, Path dir, String version) {
        return new RoiFeatureService(engine, new MapCheckpointStore(new CacheStore(dir, 0), version), standalone(),
                JSON, (rj, img, mask, label) -> {
                    extractions.incrementAndGet();
                    return rj.extractAll(img, mask, label);
                });
    }

    private static RoiFeatureRequest req(String series, Map<String, String> settings, boolean recompute) {
        return new RoiFeatureRequest("1.2", series, "1.2.8", 0, 0, 0, settings, recompute);
    }

    private static Map<String, String> settings(String... kv) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    private static Map<String, Double> values(RoiFeatureResult r) {
        Map<String, Double> m = new HashMap<>();
        for (RoiFeatureResult.Row row : r.rows()) m.put(row.column(), row.value());
        return m;
    }

    private static RoiFeatureResult.Row row(RoiFeatureResult r, String column) {
        return r.rows().stream().filter(x -> x.column().equals(column)).findFirst()
                .orElseThrow(() -> new AssertionError("列がありません: " + column));
    }

    private static long files(Path dir) throws Exception {
        if (!Files.isDirectory(dir)) return 0;
        try (Stream<Path> s = Files.list(dir)) { return s.filter(p -> p.toString().endsWith(".ckpt")).count(); }
    }

    @Test
    void definitionsAndPatientInfo(@TempDir Path dir) throws Exception {
        FixedEngine engine = new FixedEngine(volume(phantom(), mask(0)));
        RoiFeatureResult r = service(engine, dir, "t").compute(req("1.2.9", Map.of(), false), p -> { });

        assertTrue(r.rows().size() >= 150, "既定の族で 150 行以上: " + r.rows().size());
        assertTrue(r.rows().stream().noneMatch(x -> x.column().startsWith("OperationalInfo_")));
        for (RoiFeatureResult.Row x : r.rows()) {
            assertTrue(x.ibsi() == null || x.ibsi().matches("[0-9A-Z]{4}(_[0-9]+)?"), x.column());
            assertEquals(x.ibsi() == null && !x.family().equals("Diagnostics"),
                    x.notes().contains(RoiFeatureDefinitions.NOTE_NON_IBSI), x.column());
        }
        assertEquals("IPH6", row(r, "IntensityBasedStatistical_Kurtosis").ibsi());
        assertTrue(row(r, "IntensityBasedStatistical_Kurtosis").notes().contains("EXCESS_KURTOSIS"));
        assertEquals("C3I7", row(r, "IntensityHistogram_Kurtosis").ibsi());
        assertTrue(row(r, "IntensityHistogram_Kurtosis").notes().contains("EXCESS_KURTOSIS"));
        assertEquals("TLU2", row(r, "IntensityHistogram_Entropy").ibsi());
        assertTrue(row(r, "IntensityHistogram_Entropy").notes().contains("LOG2_DISCRETISED"));
        assertEquals("Q4LE", row(r, "IntensityBasedStatistical_Mean").ibsi());
        assertTrue(row(r, "Fractal_Capacity").notes().contains("NON_IBSI"));
        // パラメータ付きの IBSI 特徴（IVH の割合 10%/90%）は枝番付きで IBSI。独自量は IBSI 外のまま。
        assertEquals("BC2M_1", row(r, "IntensityVolumeHistogram_VolumeAtIntensityFraction10").ibsi());
        assertEquals("GBPN_2", row(r, "IntensityVolumeHistogram_IntensityAtVolumeFraction90").ibsi());
        assertTrue(row(r, "IntensityVolumeHistogram_VolumeAtIntensityFraction10").notes().isEmpty());
        assertNull(row(r, "IntensityBasedStatistical_TotalEnergy").ibsi());
        assertTrue(r.rows().stream().noneMatch(x -> x.family().equals("GLAM")), "GLAM は既定でオフ");
        assertTrue(r.discretisation().fixedBinNumber());
        assertEquals(32, r.discretisation().nBins());

        // 検査が効いていること: 上書きしない直接の呼び出しでは患者情報の列が出る
        ResultsTable raw = RadiomicsLock.call(() -> {
            try {
                return new RadiomicsJ().extractAll(engine.vol.image(), engine.vol.mask(), 1);
            } finally {
                RadiomicsJ.resetSettings();
                RadiomicsJ.discretiseImp = null;
            }
        });
        assertTrue(Stream.of(raw.getHeadings()).anyMatch(h -> h.startsWith("OperationalInfo_SubjectName")));
    }

    @Test
    void sameAsDirectCall_andBinCountChangesTexture(@TempDir Path dir) throws Exception {
        FixedEngine engine = new FixedEngine(volume(phantom(), mask(0)));
        RoiFeatureService svc = service(engine, dir, null);
        RoiFeatureResult r32 = svc.compute(req("1.2.9", settings("INT_binCount", "32", "BOOL_enableGLAM", "1"), false), p -> { });

        ResultsTable direct = RadiomicsLock.call(() -> {
            try {
                RadiomicsJ rj = new RadiomicsJ();
                Properties p = new Properties();
                p.put("INT_binCount", "32");
                p.put("BOOL_enableGLAM", "1");
                p.put("BOOL_enableOperationalInfo", "0");
                rj.loadSettings(p);
                ImagePlus m = engine.vol.mask().duplicate();
                m.setCalibration(engine.vol.image().getCalibration().copy());
                return rj.extractAll(engine.vol.image(), m, 1);
            } finally {
                RadiomicsJ.resetSettings();
                RadiomicsJ.discretiseImp = null;
            }
        });
        List<String> heads = Stream.of(direct.getHeadings()).filter(direct::columnExists).collect(Collectors.toList());
        assertEquals(heads, r32.rows().stream().map(RoiFeatureResult.Row::column).collect(Collectors.toList()));
        for (String h : heads) {
            double d = direct.getValue(h, direct.size() - 1);
            Double v = values(r32).get(h);
            if (Double.isNaN(d)) {
                assertNull(v, h);
            } else {
                assertEquals(Double.doubleToLongBits(d), Double.doubleToLongBits(v), h);
            }
        }
        assertTrue(r32.rows().stream().anyMatch(x -> x.family().equals("GLAM") && x.notes().contains("NON_IBSI")));

        RoiFeatureResult r16 = svc.compute(req("1.2.9", settings("INT_binCount", "16", "BOOL_enableGLAM", "1"), false), p -> { });
        assertNotEquals(values(r32).get("GLCM_JointEntropy"), values(r16).get("GLCM_JointEntropy"));
        assertEquals(16, r16.discretisation().nBins());
        assertEquals(32, RadiomicsJ.nBins, "抽出の後は既定へ戻す");
        assertNull(RadiomicsJ.discretiseImp);
    }

    @Test
    void cacheHit_andWhatInvalidatesIt(@TempDir Path dir) throws Exception {
        FixedEngine engine = new FixedEngine(volume(phantom(), mask(0)));
        RoiFeatureService svc = service(engine, dir, "t1");

        RoiFeatureResult first = svc.compute(req("1.2.9", settings("INT_binCount", "16"), false), p -> { });
        assertFalse(first.fromCache());
        assertEquals(1, extractions.get());
        assertEquals(1, files(dir));

        // 2 回目は抽出しない。シリーズ UID（＝説明などの出力の情報）が違っても画素が同じなら使う
        RoiFeatureResult second = svc.compute(req("9.9.9", settings("INT_binCount", "16"), false), p -> { });
        assertTrue(second.fromCache());
        assertEquals(1, extractions.get());
        assertEquals(values(first), values(second));
        assertEquals(first.computedAt(), second.computedAt());

        svc.compute(req("1.2.9", settings("INT_binCount", "17"), false), p -> { });
        assertEquals(2, extractions.get(), "設定が違えば計算する");

        engine.vol = volume(phantom(), mask(1));
        svc.compute(req("1.2.9", settings("INT_binCount", "16"), false), p -> { });
        assertEquals(3, extractions.get(), "マスクの画素が違えば計算する");
        engine.vol = volume(phantom(), mask(0));

        service(engine, dir, "t2").compute(req("1.2.9", settings("INT_binCount", "16"), false), p -> { });
        assertEquals(4, extractions.get(), "RadiomicsJ の版が違えば計算する");

        MapCheckpointStore store = new MapCheckpointStore(new CacheStore(dir, 0), "t1");
        Map<String, String> eff = RoiFeatureService.effectiveSettings(settings("INT_binCount", "16"), 1);
        assertNotEquals(store.featureKey(eff, engine.vol), store.featureKey("roi-features-0", eff, engine.vol),
                "エンジンの版が違えば別のキー");
        assertNotEquals(store.featureKey(eff, engine.vol),
                new MapCheckpointStore(new CacheStore(dir, 0), "t1").key(
                        new TextureSeriesRequest("1.2", "1.2.9", "1.2.8", 0, "GLCM_JointEntropy", 5, 1, false, 0, 0,
                                eff, null, null, null), engine.vol, 5, 1, false, 0),
                "マップの途中結果と取り違えない");

        // 「計算し直す」は使わずに計算し、置き換える
        RoiFeatureResult again = svc.compute(req("1.2.9", settings("INT_binCount", "16"), true), p -> { });
        assertEquals(5, extractions.get());
        assertFalse(again.fromCache());
        RoiFeatureResult afterRecompute = svc.compute(req("1.2.9", settings("INT_binCount", "16"), false), p -> { });
        assertEquals(5, extractions.get());
        assertEquals(again.computedAt(), afterRecompute.computedAt());
    }

    @Test
    void corruptEntryIsRecomputed(@TempDir Path dir) throws Exception {
        FixedEngine engine = new FixedEngine(volume(phantom(), mask(0)));
        RoiFeatureService svc = service(engine, dir, "t1");
        RoiFeatureResult first = svc.compute(req("1.2.9", Map.of(), false), p -> { });
        Path f;
        try (Stream<Path> s = Files.list(dir)) {
            f = s.filter(p -> p.toString().endsWith(".ckpt")).findFirst().orElseThrow();
        }
        byte[] raw = Files.readAllBytes(f);
        raw[raw.length / 2] = '#';
        Files.write(f, raw);

        RoiFeatureResult second = svc.compute(req("1.2.9", Map.of(), false), p -> { });
        assertEquals(2, extractions.get());
        assertFalse(second.fromCache());
        assertEquals(values(first), values(second));
        assertTrue(svc.compute(req("1.2.9", Map.of(), false), p -> { }).fromCache(), "壊れた項目は置き換わる");
    }

    @Test
    void unknownVersionDisablesCache(@TempDir Path dir) throws Exception {
        FixedEngine engine = new FixedEngine(volume(phantom(), mask(0)));
        RoiFeatureService svc = service(engine, dir, null);
        svc.compute(req("1.2.9", Map.of(), false), p -> { });
        assertFalse(svc.compute(req("1.2.9", Map.of(), false), p -> { }).fromCache());
        assertEquals(2, extractions.get());
        assertEquals(0, files(dir));
    }

    @Test
    void rejectsBadRequests(@TempDir Path dir) {
        RoiFeatureService svc = service(new FixedEngine(volume(phantom(), mask(0))), dir, "t");
        assertThrows(IllegalArgumentException.class,
                () -> svc.check(req("1.2.9", settings("INT_binCont", "16"), false)), "打ち間違いのキー");
        assertThrows(IllegalArgumentException.class,
                () -> svc.check(req("1.2.9", settings("BINCOUNT_GLCM_INT", "16"), false)), "Next のマップ用のキー");
        assertThrows(IllegalArgumentException.class,
                () -> svc.check(req("1.2.9", settings("BOOL_force2D", "1"), false)));
        assertThrows(IllegalArgumentException.class,
                () -> svc.check(new RoiFeatureRequest("1.2", "1.2.9", null, 0, 0, 0, Map.of(), false)));
        assertThrows(IllegalArgumentException.class,
                () -> svc.check(req("1.2.9", settings("INT_label", "0"), false)));
        assertDoesNotThrow(() -> svc.check(req("1.2.9", settings("BOOL_force2D", "0", "INT_binCount", "8"), false)));

        Map<String, String> eff = RoiFeatureService.effectiveSettings(settings("BOOL_enableOperationalInfo", "1"), 2);
        assertEquals("0", eff.get("BOOL_enableOperationalInfo"), "患者情報の族は常に切る");
        assertEquals("2", eff.get("INT_label"));

        // ROI が空
        ImagePlus empty = mask(0);
        for (int z = 1; z <= D; z++) empty.getStack().getProcessor(z).setValue(0);
        for (int z = 1; z <= D; z++) empty.getStack().getProcessor(z).fill();
        RoiFeatureService svcEmpty = service(new FixedEngine(volume(phantom(), empty)), dir, "t");
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> svcEmpty.compute(req("1.2.9", Map.of(), false), p -> { }));
        assertTrue(e.getMessage().contains("ROI が空"));
        assertEquals(0, extractions.get());

        RoiFeatureService web = new RoiFeatureService(new FixedEngine(volume(phantom(), mask(0))),
                new MapCheckpointStore(new CacheStore(dir, 0), "t"), new RadiomicsMode(new MockEnvironment()), JSON);
        assertThrows(IllegalStateException.class, () -> web.check(req("1.2.9", Map.of(), false)));
    }

    @Test
    void cancelledJobStillFillsTheCache(@TempDir Path dir) throws Exception {
        FixedEngine engine = new FixedEngine(volume(phantom(), mask(0)));
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        RoiFeatureService blocking = new RoiFeatureService(engine,
                new MapCheckpointStore(new CacheStore(dir, 0), "t"), standalone(), JSON, (rj, img, mask, label) -> {
                    extractions.incrementAndGet();
                    entered.countDown();
                    assertTrue(release.await(30, TimeUnit.SECONDS));
                    return rj.extractAll(img, mask, label);
                });
        RoiFeatureJobService jobs = new RoiFeatureJobService(blocking);
        RoiFeatureJobService.Status s = jobs.submit(req("1.2.9", Map.of(), false));
        assertTrue(entered.await(30, TimeUnit.SECONDS));
        assertEquals(RoiFeatureJobService.State.EXTRACTING, jobs.get(s.jobId()).state());
        assertEquals(RoiFeatureJobService.State.CANCELLED, jobs.cancel(s.jobId()).state());
        release.countDown();

        long deadline = System.currentTimeMillis() + 60_000;
        while (files(dir) == 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(50);
        }
        assertEquals(1, files(dir), "取り消しても、走り終えた結果はキャッシュに入る");
        assertEquals(RoiFeatureJobService.State.CANCELLED, jobs.get(s.jobId()).state());
        assertNull(jobs.get(s.jobId()).result(), "取り消したジョブの結果は見せない");

        RoiFeatureResult next = blocking.compute(req("1.2.9", Map.of(), false), p -> { });
        assertTrue(next.fromCache());
        assertEquals(1, extractions.get());
    }

    @Test
    void mapWaitsWhileTheLockIsHeld(@TempDir Path dir) throws Exception {
        ImagePlus img = phantom();
        RadiomicsMapEngine.LoadedVolume vol = volume(img, mask(0));
        RadiomicsMapEngine engine = new RadiomicsMapEngine(null, new MapCheckpointStore(new CacheStore(dir, 0), null));
        Map<String, String> s = settings("MASK_LABEL_INT", "1");
        TextureSeriesRequest map = new TextureSeriesRequest("1.2", "1.2.9", "1.2.8", 0, "GLCM_JointEntropy", 5, 1,
                false, 0, 0, s, null, null, null);
        float[][] alone = engine.computeFrom(map, TextureProgress.NONE, vol).map().data();

        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Thread holder = new Thread(() -> {
            try {
                RadiomicsLock.call(() -> {
                    // 抽出の途中と同じ状態: 全体の離散化画像と、既定でないビン数
                    RadiomicsJ.discretiseImp = new ImagePlus("junk", new ByteProcessor(3, 3));
                    RadiomicsJ.nBins = 3;
                    held.countDown();
                    assertTrue(release.await(60, TimeUnit.SECONDS));
                    RadiomicsJ.resetSettings();
                    RadiomicsJ.discretiseImp = null;
                    return null;
                });
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        holder.start();
        assertTrue(held.await(30, TimeUnit.SECONDS));

        AtomicInteger slicesDone = new AtomicInteger();
        AtomicReference<float[][]> during = new AtomicReference<>();
        Thread mapper = new Thread(() -> during.set(engine.computeFrom(map,
                (done, total) -> slicesDone.set(done), vol).map().data()));
        mapper.start();
        Thread.sleep(800);
        assertEquals(0, slicesDone.get(), "ロックを握られている間、マップはスライスを進めない");
        release.countDown();
        holder.join(60_000);
        mapper.join(120_000);
        assertNotNull(during.get());
        assertEquals(alone.length, during.get().length);
        for (int z = 0; z < alone.length; z++) {
            assertArrayEquals(alone[z], during.get()[z], "slice " + z);
        }
    }
}
