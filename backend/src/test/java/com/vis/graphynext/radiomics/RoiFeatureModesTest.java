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

import java.nio.file.Path;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Properties;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

/** ROI 特徴量: 計算の単位（最大断面 2D・スライス別 2D）。 */
class RoiFeatureModesTest {

    private static final int W = 32, H = 32, N = 4;
    private static final double SP = 0.7;
    /** 各スライスの前景の (縦, 横)。0 は前景なし。濃度は 100・200 の一定。 */
    private static final int[][] FG = {{10, 10}, {20, 15}, {0, 0}, {0, 0}};
    private static final float[] LEVEL = {100f, 200f, 0f, 0f};
    private static final double[] POS = {0, 2, 4, 6};

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    private static RadiomicsMapEngine.LoadedVolume volume(int[][] fg, float[] level, String aligned) {
        ImageStack is = new ImageStack(W, H);
        ImageStack ms = new ImageStack(W, H);
        long seed = 99L;
        for (int z = 0; z < N; z++) {
            FloatProcessor ip = new FloatProcessor(W, H);
            ByteProcessor mp = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) {
                for (int x = 0; x < W; x++) {
                    seed = seed * 6364136223846793005L + 1442695040888963407L;
                    boolean in = y < fg[z][0] && x < fg[z][1];
                    // 背景は乱数、前景は一定値（平均が手で出せる）
                    ip.setf(x, y, in ? level[z] : (int) Math.floorMod(seed >> 33, 50));
                    mp.set(x, y, in ? 1 : 0);
                }
            }
            is.addSlice(ip);
            ms.addSlice(mp);
        }
        ImagePlus img = new ImagePlus("i", is);
        Calibration c = img.getCalibration();
        c.pixelWidth = SP;
        c.pixelHeight = SP;
        c.pixelDepth = 2.0;
        ImagePlus mask = new ImagePlus("m", ms);
        mask.setProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED, aligned);
        Map<Integer, double[]> ipp = new HashMap<>();
        String[] sops = new String[N];
        for (int z = 0; z < N; z++) {
            ipp.put(z, new double[] {0, 0, POS[z]});
            sops[z] = "1.2.3." + z;
        }
        return new RadiomicsMapEngine.LoadedVolume(img, mask, W, H, N, 1, true, c,
                new double[] {1, 0, 0, 0, 1, 0}, SP, SP, ipp, sops, null, null, false);
    }

    private static final class FixedEngine extends RadiomicsMapEngine {
        final LoadedVolume vol;

        FixedEngine(LoadedVolume vol) {
            super(null, new MapCheckpointStore(new CacheStore(Path.of("unused"), 0), null), null);
            this.vol = vol;
        }

        @Override
        public LoadedVolume load(String study, String series, int channel, int timePoint, String maskSeries,
                                 int maskChannel, int label, Map<String, String> settings) {
            return vol;
        }
    }

    private static RadiomicsMode standalone() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("standalone");
        return new RadiomicsMode(env);
    }

    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();

    private RoiFeatureService service(RadiomicsMapEngine.LoadedVolume vol, Path dir, RoiFeatureService.Extractor ex,
                                      String small2d) {
        return new RoiFeatureService(new FixedEngine(vol),
                new MapCheckpointStore(new CacheStore(dir, 0), "t"), standalone(), JSON, ex, "9.9.9-test",
                () -> null, () -> small2d);
    }

    private static final RoiFeatureService.Extractor REAL = (rj, img, mask, label) -> rj.extractAll(img, mask, label);

    private static RoiFeatureRequest req(java.util.Set<RoiFeatureRequest.RoiMode> modes, Map<String, String> s) {
        return new RoiFeatureRequest("1.2", "1.2.9", "1.2.8", 0, 0, 0, s, false, modes);
    }

    private static Double value(List<RoiFeatureResult.Row> rows, String column) {
        return rows.stream().filter(r -> r.column().equals(column)).findFirst()
                .orElseThrow(() -> new AssertionError("列がありません: " + column)).value();
    }

    private static final String MEAN = "IntensityBasedStatistical_Mean";

    @Test
    void sliceAggregatesDifferFromWholeVolume(@TempDir Path dir) throws Exception {
        RoiFeatureResult r = service(volume(FG, LEVEL, "1"), dir, REAL, null).compute(
                req(EnumSet.allOf(RoiFeatureRequest.RoiMode.class), Map.of()), p -> { });
        // 手計算: (100×100 + 200×300) / 400 = 175
        assertEquals(175.0, value(r.rows(), MEAN), 1e-6, "3D 全腫瘍");
        RoiFeatureResult.Slices s = r.slices();
        assertEquals(2, s.rows().size(), "行数＝前景のあるスライス数");
        assertEquals(2, s.foregroundSlices());
        assertTrue(s.failures().isEmpty());
        assertEquals(100.0, value(s.rows().get(0).rows(), MEAN), 1e-6);
        assertEquals(200.0, value(s.rows().get(1).rows(), MEAN), 1e-6);
        assertEquals(150.0, value(s.mean(), MEAN), 1e-6, "単純平均");
        assertEquals(175.0, value(s.pixelWeightedMean(), MEAN), 1e-6, "画素数の重み付き平均");
        assertNotEquals(value(r.rows(), MEAN), value(s.mean(), MEAN), "単純平均は 3D と食い違う（負例）");
        assertEquals(2, s.slicesUsed().get(MEAN));
        assertEquals(0.0, s.rows().get(0).positionMm(), 1e-9);
        assertEquals(100, s.rows().get(0).pixels());
        assertEquals(300, s.rows().get(1).pixels());
        assertEquals(300 * SP * SP, s.rows().get(1).areaMm2(), 1e-9);
    }

    @Test
    void maxSectionMatchesDirectForce2dCall(@TempDir Path dir) throws Exception {
        RadiomicsMapEngine.LoadedVolume vol = volume(FG, LEVEL, "1");
        RoiFeatureResult r = service(vol, dir, REAL, null).compute(
                req(EnumSet.of(RoiFeatureRequest.RoiMode.MAX_SECTION_2D), Map.of()), p -> { });
        RoiFeatureResult.Section sec = r.section();
        assertNull(r.slices());
        assertEquals(2.0, sec.positionMm(), 1e-9, "最大断面は 300 画素のスライス（位置 2 mm）");
        assertEquals(300, sec.pixels());

        // 試験の中で 1 枚を組み立てて RadiomicsJ を force2D で直接呼ぶ
        ImagePlus img = new ImagePlus("s", vol.image().getStack().getProcessor(2).duplicate());
        ImagePlus mask = new ImagePlus("sm", vol.mask().getStack().getProcessor(2).duplicate());
        img.setCalibration(vol.calibration().copy());
        mask.setCalibration(vol.calibration().copy());
        ResultsTable direct = RadiomicsLock.call(() -> {
            try {
                Properties p = new Properties();
                p.putAll(RoiFeatureService.effectiveSettings(Map.of("BOOL_force2D", "0"), 1));
                p.put("BOOL_force2D", "1");
                RadiomicsJ rj = new RadiomicsJ();
                rj.loadSettings(p);
                return rj.extractAll(img, mask, 1);
            } finally {
                RadiomicsJ.resetSettings();
                RadiomicsJ.discretiseImp = null;
            }
        });
        List<RoiFeatureResult.Row> mine = sec.rows();
        int last = direct.size() - 1;
        int compared = 0;
        for (String h : direct.getHeadings()) {
            if (!direct.columnExists(h)) continue;
            double d = direct.getValue(h, last);
            Double m = value(mine, h);
            if (Double.isNaN(d)) {
                assertNull(m, h);
            } else {
                assertEquals(Double.doubleToLongBits(d), Double.doubleToLongBits(m), h);
            }
            compared++;
        }
        assertEquals(mine.size(), compared);
        assertEquals(sec.areaMm2(), value(mine, "Shape2D_PixelSurface"), 1e-9, "Shape2D_PixelSurface＝最大断面の面積");
        assertTrue(mine.stream().noneMatch(x -> x.family().equals("Morphology") || x.family().equals("GLAM")),
                "2D に Morphology・GLAM の列は出ない");
        assertTrue(r.rows().stream().anyMatch(x -> x.family().equals("Morphology")), "3D は今までどおり");
        assertTrue(r.rows().stream().noneMatch(x -> x.family().equals("Shape2D")), "3D に Shape2D は出ない");
    }

    @Test
    void failedSliceIsReportedNotSkipped(@TempDir Path dir) throws Exception {
        RoiFeatureService.Extractor flaky = (rj, img, mask, label) ->
                "slice-1".equals(img.getTitle()) ? null : rj.extractAll(img, mask, label);
        RoiFeatureResult r = service(volume(FG, LEVEL, "1"), dir, flaky, null).compute(
                req(EnumSet.of(RoiFeatureRequest.RoiMode.SLICES_2D), Map.of()), p -> { });
        RoiFeatureResult.Slices s = r.slices();
        assertEquals(1, s.rows().size());
        assertEquals(1, s.failures().size());
        assertEquals(2.0, s.failures().get(0).positionMm(), 1e-9, "失敗した位置が載る");
        assertEquals(2, s.foregroundSlices());
        assertEquals(1, s.slicesUsed().get(MEAN), "使った枚数が 1 減る");
        assertEquals(100.0, value(s.mean(), MEAN), 1e-6);
    }

    @Test
    void progressIsReportedAndCancelStopsAtSliceBoundary(@TempDir Path dir) throws Exception {
        java.util.List<String> seen = new java.util.ArrayList<>();
        AtomicBoolean cancel = new AtomicBoolean();
        RoiFeatureService svc = service(volume(FG, LEVEL, "1"), dir, REAL, null);
        assertThrows(java.util.concurrent.CancellationException.class, () -> svc.compute(
                req(EnumSet.of(RoiFeatureRequest.RoiMode.SLICES_2D), Map.of()), p -> { },
                (done, total) -> {
                    seen.add(done + "/" + total);
                    if (done == 1) cancel.set(true);
                }, cancel::get));
        assertEquals(List.of("0/2", "1/2"), seen, "1 枚終えたところで止まる");
    }

    @Test
    void userForce2dIsRejectedAndDefaultIsWholeOnly(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = service(volume(FG, LEVEL, "1"), dir, REAL, null);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> svc.check(req(null, Map.of("BOOL_force2D", "1"))));
        assertTrue(e.getMessage().contains("計算の単位"));
        RoiFeatureResult r = svc.compute(req(null, Map.of()), p -> { });
        assertNull(r.section());
        assertNull(r.slices());
    }

    @Test
    void geometryUnknownIsRefusedFor2d(@TempDir Path dir) {
        RoiFeatureService svc = service(volume(FG, LEVEL, "0"), dir, REAL, null);
        assertThrows(IllegalArgumentException.class, () -> svc.compute(
                req(EnumSet.of(RoiFeatureRequest.RoiMode.SLICES_2D), Map.of()), p -> { }));
    }

    @Test
    void smallRoiWarningUsesThe2dSetting(@TempDir Path dir) throws Exception {
        RoiFeatureResult r = service(volume(FG, LEVEL, "1"), dir, REAL, "150").compute(
                req(EnumSet.of(RoiFeatureRequest.RoiMode.SLICES_2D), Map.of()), p -> { });
        assertEquals(150, r.slices().smallRoiWarnPixels());
        assertEquals(List.of(0.0), r.slices().smallRoiPositionsMm(), "100 画素のスライスだけが小さい");
        RoiFeatureResult none = service(volume(FG, LEVEL, "1"), dir, REAL, null).compute(
                req(EnumSet.of(RoiFeatureRequest.RoiMode.SLICES_2D), Map.of()), p -> { });
        assertNull(none.slices().smallRoiWarnPixels());
        assertTrue(none.slices().smallRoiPositionsMm().isEmpty());
    }

    @Test
    void cacheServesSecondRequestAndDoesNotTouchWholeKey(@TempDir Path dir) throws Exception {
        int[] calls = {0};
        RoiFeatureService.Extractor counting = (rj, img, mask, label) -> {
            calls[0]++;
            return rj.extractAll(img, mask, label);
        };
        RoiFeatureService svc = service(volume(FG, LEVEL, "1"), dir, counting, null);
        RoiFeatureRequest rq = req(EnumSet.allOf(RoiFeatureRequest.RoiMode.class), Map.of());
        RoiFeatureResult a = svc.compute(rq, p -> { });
        int first = calls[0];
        assertEquals(1 + 1 + 2, first, "3D 1 回＋最大断面 1 回＋スライス 2 枚");
        RoiFeatureResult b = svc.compute(rq, p -> { });
        assertEquals(first, calls[0], "2 回目は全部キャッシュ");
        assertTrue(b.fromCache());
        assertTrue(b.section().fromCache());
        assertTrue(b.slices().fromCache());
        assertEquals(value(a.slices().mean(), MEAN), value(b.slices().mean(), MEAN), 0.0);
        // 3D だけの要求は 3D のキャッシュに当たり、2D は計算しない
        RoiFeatureResult c = svc.compute(req(null, Map.of()), p -> { });
        assertEquals(first, calls[0]);
        assertTrue(c.fromCache());
        assertNull(c.section());
    }
}
