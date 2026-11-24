/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.cache.CacheStore;
import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;

/**
 * ROI 特徴量: 値なし（NaN）を含む画像。ROI の内側にあれば断る。外側だけなら通し、NaN の無い画像と全列が一致する。
 * 例外は局所強度の 2 列（NaN が球半径 約 6.2 mm の近傍に届くときだけ空欄）と、画像全体の平均（NaN を含むと null）。
 */
class RoiFeatureNanInputTest {

    static final int W = 32, H = 32, N = 20;
    // ROI: x 12..17, y 12..17, z 8..11（1 mm 等方）
    static boolean roi(int x, int y, int z) { return x >= 12 && x <= 17 && y >= 12 && y <= 17 && z >= 8 && z <= 11; }

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    static RadiomicsMapEngine.LoadedVolume volume(int[] nanAt) {
        ImageStack is = new ImageStack(W, H);
        ImageStack ms = new ImageStack(W, H);
        long seed = 31L;
        for (int z = 0; z < N; z++) {
            FloatProcessor ip = new FloatProcessor(W, H);
            ByteProcessor mp = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                seed = seed * 6364136223846793005L + 1442695040888963407L;
                ip.setf(x, y, (int) Math.floorMod(seed >> 33, 40) + 10f);
                mp.set(x, y, roi(x, y, z) ? 1 : 0);
            }
            is.addSlice(ip);
            ms.addSlice(mp);
        }
        if (nanAt != null) is.getProcessor(nanAt[2] + 1).setf(nanAt[0], nanAt[1], Float.NaN);
        ImagePlus img = new ImagePlus("i", is);
        Calibration c = img.getCalibration();
        c.pixelWidth = 1; c.pixelHeight = 1; c.pixelDepth = 1;
        ImagePlus mask = new ImagePlus("m", ms);
        mask.setProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED, "1");
        Map<Integer, double[]> ipp = new HashMap<>();
        String[] sops = new String[N];
        for (int z = 0; z < N; z++) {
            ipp.put(z, new double[] {0, 0, z});
            sops[z] = "1.2.3." + z;
        }
        return new RadiomicsMapEngine.LoadedVolume(img, mask, W, H, N, 1, true, c, new double[] {1, 0, 0, 0, 1, 0},
                1, 1, ipp, sops, null, null, false);
    }

    static final class FixedEngine extends RadiomicsMapEngine {
        final LoadedVolume vol;
        FixedEngine(LoadedVolume vol) {
            super(null, new MapCheckpointStore(new CacheStore(Path.of("unused"), 0), null), null);
            this.vol = vol;
        }
        @Override
        public LoadedVolume load(String study, String series, int channel, int timePoint, String maskSeries,
                                 int maskChannel, int label, Map<String, String> settings, boolean allowRectify) {
            return vol;
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();

    static RoiFeatureResult run(int[] nanAt, EnumSet<RoiFeatureRequest.RoiMode> modes, Map<String, String> settings,
                                Path dir) throws Exception {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("standalone");
        RoiFeatureService svc = new RoiFeatureService(new FixedEngine(volume(nanAt)),
                new MapCheckpointStore(new CacheStore(dir, 0), "t"), new RadiomicsMode(env), JSON,
                (rj, img, mask, label) -> rj.extractAll(img, mask, label), "9.9.9-test", () -> null, () -> null);
        return svc.compute(new RoiFeatureRequest("1.2", "1.2.9", "1.2.8", 0, 0, 0, settings, true, modes), p -> { });
    }

    static Map<String, RoiFeatureResult.Row> byColumn(RoiFeatureResult r) {
        Map<String, RoiFeatureResult.Row> m = new LinkedHashMap<>();
        for (RoiFeatureResult.Row row : r.rows()) m.put(row.column(), row);
        return m;
    }

    private static final EnumSet<RoiFeatureRequest.RoiMode> WHOLE = EnumSet.of(RoiFeatureRequest.RoiMode.WHOLE_3D);

    /** NaN の無い画像と全列を突き合わせ、違う列の名前を返す。 */
    static List<String> differingColumns(RoiFeatureResult clean, RoiFeatureResult other) {
        Map<String, RoiFeatureResult.Row> a = byColumn(clean), b = byColumn(other);
        assertEquals(a.keySet(), b.keySet(), "列は同じ");
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        for (String c : a.keySet()) {
            Double x = a.get(c).value(), y = b.get(c).value();
            boolean same = (x == null && y == null) || (x != null && y != null && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x)));
            if (!same) out.add(c);
        }
        return out;
    }

    private static final List<String> IMAGE_MEAN = List.of("Diagnostics_DiagnosticsInitialImageMeanIntensity",
            "Diagnostics_DiagnosticsInterpolatedImageMeanIntensity");

    @Test
    void nanInsideTheRoiIsRefusedWithAReason(@TempDir Path dir) {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> run(new int[] {14, 14, 9}, WHOLE, Map.of(), dir));
        assertTrue(e.getMessage().contains("ROI の内側"), e.getMessage());
        assertTrue(e.getMessage().contains("元の画像"), "元の画像を使う案内がある: " + e.getMessage());
    }

    @Test
    void nanFarFromTheRoiGivesTheSameValuesAsAnImageWithoutNan(@TempDir Path dir) throws Exception {
        RoiFeatureResult clean = run(null, WHOLE, Map.of(), dir.resolve("a"));
        // (0,0,0) は遠い。(5,14,9) は ROI（x=12 から）7 mm: 球半径 約 6.2 mm の外
        for (int[] at : new int[][] {{0, 0, 0}, {5, 14, 9}}) {
            RoiFeatureResult r = run(at, WHOLE, Map.of(), dir.resolve("f" + at[0]));
            List<String> diff = differingColumns(clean, r);
            assertTrue(IMAGE_MEAN.containsAll(diff), "違うのは画像全体の平均だけ: " + diff);
            for (String c : IMAGE_MEAN) assertNull(byColumn(r).get(c).value(), c + " は NaN を含むと null");
            assertTrue(r.provenance().recordFlags().contains(RoiFeatureService.FLAG_NAN_OUTSIDE_ROI));
            assertFalse(r.provenance().recordFlags().contains(RoiFeatureService.FLAG_NAN_LOCAL_PEAK_UNDEFINED));
            assertNotNull(byColumn(r).get("LocalIntensity_LocalIntensityPeak").value(), "遠いなら局所強度も計算できる");
        }
    }

    @Test
    void nanNearTheRoiBlanksOnlyTheTwoLocalPeakColumns(@TempDir Path dir) throws Exception {
        RoiFeatureResult clean = run(null, WHOLE, Map.of(), dir.resolve("a"));
        assertNotNull(byColumn(clean).get("LocalIntensity_LocalIntensityPeak").value());
        // ROI の 1 mm 隣と 6 mm 隣（6.2 mm の内）
        for (int[] at : new int[][] {{11, 14, 9}, {6, 14, 9}, {14, 14, 2}}) {
            RoiFeatureResult r = run(at, WHOLE, Map.of(), dir.resolve("n" + at[0] + at[2]));
            List<String> diff = differingColumns(clean, r);
            java.util.ArrayList<String> allowed = new java.util.ArrayList<>(IMAGE_MEAN);
            allowed.add("LocalIntensity_LocalIntensityPeak");
            allowed.add("LocalIntensity_GlobalIntensityPeak");
            assertTrue(allowed.containsAll(diff), "違うのは 2 列＋画像全体の平均だけ: " + diff);
            for (String c : List.of("LocalIntensity_LocalIntensityPeak", "LocalIntensity_GlobalIntensityPeak")) {
                RoiFeatureResult.Row row = byColumn(r).get(c);
                assertNull(row.value(), c + " は 0 や既定値でなく null");
                assertTrue(row.notes().contains(RoiFeatureService.NOTE_NAN_NEIGHBOUR), "理由の注記: " + row.notes());
            }
            assertTrue(r.provenance().recordFlags().contains(RoiFeatureService.FLAG_NAN_OUTSIDE_ROI));
            assertTrue(r.provenance().recordFlags().contains(RoiFeatureService.FLAG_NAN_LOCAL_PEAK_UNDEFINED));
        }
    }

    @Test
    void nanOutsideTheRoiWithInterpolationOrFiltersOr2dIsRefused(@TempDir Path dir) {
        int[] far = {0, 0, 0};
        for (Map<String, String> s : List.of(Map.of("DOUBLEARRAY_resamplingFactorXYZ", "2,2,2"),
                Map.of("DOUBLEARRAY_logSigmaMm", "1.5"))) {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> run(far, WHOLE, s, dir.resolve("s" + s.size() + s.keySet())));
            assertTrue(e.getMessage().contains("広がります"), e.getMessage());
        }
        IllegalArgumentException e2 = assertThrows(IllegalArgumentException.class,
                () -> run(far, EnumSet.of(RoiFeatureRequest.RoiMode.WHOLE_3D, RoiFeatureRequest.RoiMode.SLICES_2D), Map.of(), dir.resolve("d2")));
        assertTrue(e2.getMessage().contains("2D"), e2.getMessage());
    }

    @Test
    void anImageWithoutNanIsUntouched(@TempDir Path dir) throws Exception {
        RoiFeatureResult r = run(null, WHOLE, Map.of(), dir);
        assertFalse(r.provenance().recordFlags().contains(RoiFeatureService.FLAG_NAN_OUTSIDE_ROI));
        assertNotNull(byColumn(r).get("LocalIntensity_LocalIntensityPeak").value());
        assertNotNull(byColumn(r).get(IMAGE_MEAN.get(0)).value());
    }
}
