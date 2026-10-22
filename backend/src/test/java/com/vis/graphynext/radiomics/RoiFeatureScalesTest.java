/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

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

import java.io.StringReader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

/** ROI 特徴量: 構造の半径 r（mm）での指定と、複数スケールの一括計算。 */
class RoiFeatureScalesTest {

    private static final String MEAN = "IntensityBasedStatistical_Mean";

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    private static RoiFeatureRequest req(Map<String, String> settings, List<Double> scales, String conversion,
                                         Double k, EnumSet<RoiFeatureRequest.RoiMode> modes) {
        return new RoiFeatureRequest("1.2", "1.2.9", "1.2.8", 0, 0, 0, settings, false, modes, scales, null, null,
                conversion, k);
    }

    private static List<Double> range(double from, double to, double step) {
        List<Double> out = new ArrayList<>();
        for (double r = from; r <= to + 1e-9; r += step) out.add(Math.round(r * 100) / 100.0);
        return out;
    }

    // ───────────── 換算の意味（合成の円板・球） ─────────────

    private static final int N = 64;
    private static final double PX = 0.5;
    private static final double RADIUS_MM = 4.0;

    /** 面内 0.5 mm、中心に半径 4 mm の明るい円板（sphere=false は z に一様な円柱）か球。ROI は中心の 3×3(×3) 画素。 */
    private static RadiomicsMapEngine.LoadedVolume blob(boolean sphere) {
        int depth = sphere ? N : 9;
        double c = (N - 1) / 2.0, cz = (depth - 1) / 2.0;
        ImageStack is = new ImageStack(N, N);
        ImageStack ms = new ImageStack(N, N);
        for (int k = 0; k < depth; k++) {
            FloatProcessor ip = new FloatProcessor(N, N);
            ByteProcessor mp = new ByteProcessor(N, N);
            for (int y = 0; y < N; y++) {
                for (int x = 0; x < N; x++) {
                    double dx = (x - c) * PX, dy = (y - c) * PX, dz = sphere ? (k - cz) * PX : 0;
                    boolean in = dx * dx + dy * dy + dz * dz <= RADIUS_MM * RADIUS_MM;
                    ip.setf(x, y, in ? 1000f : 0f);
                    boolean roi = Math.abs(x - c) <= 1.0 && Math.abs(y - c) <= 1.0 && (!sphere || Math.abs(k - cz) <= 1.0);
                    mp.set(x, y, roi ? 1 : 0);
                }
            }
            is.addSlice(ip);
            ms.addSlice(mp);
        }
        ImagePlus img = new ImagePlus("i", is);
        Calibration cal = img.getCalibration();
        cal.pixelWidth = PX;
        cal.pixelHeight = PX;
        cal.pixelDepth = PX;
        ImagePlus mask = new ImagePlus("m", ms);
        mask.setProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED, "1");
        Map<Integer, double[]> ipp = new HashMap<>();
        String[] sops = new String[depth];
        for (int k = 0; k < depth; k++) {
            ipp.put(k, new double[] {0, 0, k * PX});
            sops[k] = "1.2.3." + k;
        }
        return new RadiomicsMapEngine.LoadedVolume(img, mask, N, N, depth, 1, true, cal,
                new double[] {1, 0, 0, 0, 1, 0}, PX, PX, ipp, sops, null, null, false);
    }

    private static Map<String, String> meanOnly() {
        Map<String, String> m = new HashMap<>();
        for (String k : List.of("Morphological", "LocalIntensityFeatures", "IntensityHistogram", "IntensityVolumeHistogram",
                "GLCM", "GLRLM", "GLSZM", "GLDZM", "NGTDM", "NGLDM", "Fractal", "Shape2D")) {
            m.put("BOOL_enable" + k, "0");
        }
        return m;
    }

    /** 中心の σ² 正規化応答（画素単位の σ で掛ける）の絶対値が最大になる r。 */
    private static double peakScale(boolean sphere, String conversion, Path dir) throws Exception {
        RoiFeatureService svc = RoiFeatureLogTest.service(blob(sphere), dir);
        List<Double> scales = range(1.0, 7.0, 0.25);
        boolean twoD = !sphere;
        RoiFeatureResult res = svc.compute(
                req(meanOnly(), scales, conversion, null,
                        twoD ? EnumSet.of(RoiFeatureRequest.RoiMode.MAX_SECTION_2D) : null),
                p -> { }, (d, t) -> { }, () -> false);
        double bestR = -1, best = -1;
        for (RoiFeatureResult.ScaleEntry e : res.scales()) {
            double sigma = twoD ? e.sigma2dMm() : e.sigma3dMm();
            List<RoiFeatureResult.Row> rows = twoD ? e.result().section().rows() : e.result().rows();
            // 1 スケールにつき LoG の σ は 1 つ。列名の σ の書き方（1 か 1.0 か）は RadiomicsJ に任せる
            List<Double> hits = rows.stream()
                    .filter(rw -> rw.column().startsWith("log_sigma") && rw.column().endsWith("mm_" + MEAN))
                    .map(RoiFeatureResult.Row::value).toList();
            assertEquals(1, hits.size(), "r=" + e.scaleMm());
            Double v = hits.get(0);
            assertNotNull(v);
            double score = Math.abs(v) * (sigma / PX) * (sigma / PX);
            if (score > best) {
                best = score;
                bestR = e.scaleMm();
            }
        }
        return bestR;
    }

    @Test
    void sqrtDConversionPeaksAtTheDiscRadius(@TempDir Path dir) throws Exception {
        double r = peakScale(false, "SQRT_D", dir);
        assertEquals(RADIUS_MM, r, 0.25, "2D: 応答が最大になる r が円板の半径に入る");
    }

    @Test
    void sqrtDConversionPeaksAtTheSphereRadius(@TempDir Path dir) throws Exception {
        double r = peakScale(true, "SQRT_D", dir);
        assertEquals(RADIUS_MM, r, 0.25, "3D: 応答が最大になる r が球の半径に入る");
    }

    @Test
    void identityConversionPeaksElsewhere(@TempDir Path dir) throws Exception {
        // 負例: σ=r にすると最大は R/√d 付近（2D で約 2.83 mm）に出て、半径に合わない
        double r = peakScale(false, "IDENTITY", dir);
        assertTrue(Math.abs(r - RADIUS_MM) > 0.25, "換算を取り違えると半径から外れる: " + r);
        assertEquals(RADIUS_MM / Math.sqrt(2), r, 0.5);
    }

    // ───────────── スケールの並び ─────────────

    @Test
    void scaleZeroIsTheUnfilteredTableBitForBit(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(1.0, 1.0), dir);
        RoiFeatureResult plain = svc.compute(req(Map.of(), null, null, null, null), p -> { });
        RoiFeatureResult scaled = svc.compute(req(Map.of(), List.of(0.0, 2.0), null, null, null), p -> { });
        assertEquals(2, scaled.scales().size());
        RoiFeatureResult zero = scaled.scales().get(0).result();
        assertNull(scaled.scales().get(0).sigma3dMm(), "r=0 は σ なし（フィルタなし）");
        assertEquals(plain.rows().size(), zero.rows().size());
        for (int i = 0; i < plain.rows().size(); i++) {
            Double a = plain.rows().get(i).value(), b = zero.rows().get(i).value();
            assertEquals(plain.rows().get(i).column(), zero.rows().get(i).column());
            if (a == null) assertNull(b);
            else assertEquals(Double.doubleToLongBits(a), Double.doubleToLongBits(b), plain.rows().get(i).column());
        }
        assertTrue(zero.rows().stream().noneMatch(r -> r.column().startsWith("log_sigma")));
        // トップレベルは先頭スケール
        assertEquals(zero.rows().size(), scaled.rows().size());
        // r=2 の行はフィルタ後の列を持つ（0 をフィルタありで計算する取り違えを検出する対照）
        assertTrue(scaled.scales().get(1).result().rows().stream().anyMatch(r -> r.column().startsWith("log_sigma1.1547mm_")));
    }

    @Test
    void eachScaleIsCachedSeparately(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(1.0, 1.0), dir);
        RoiFeatureResult first = svc.compute(req(Map.of(), List.of(0.0, 2.0), null, null, null), p -> { });
        assertFalse(first.scales().get(0).result().fromCache());
        assertFalse(first.scales().get(1).result().fromCache());
        RoiFeatureResult more = svc.compute(req(Map.of(), List.of(0.0, 2.0, 3.0), null, null, null), p -> { });
        assertTrue(more.scales().get(0).result().fromCache(), "0 はキャッシュから");
        assertTrue(more.scales().get(1).result().fromCache(), "2 はキャッシュから");
        assertFalse(more.scales().get(2).result().fromCache(), "3 だけ新しく計算");
        // 負例: 換算を変えれば同じ r でも別の計算（スケールだけが鍵ではない）
        RoiFeatureResult ident = svc.compute(req(Map.of(), List.of(2.0), "IDENTITY", null, null), p -> { });
        assertFalse(ident.scales().get(0).result().fromCache());
    }

    @Test
    void settingsFileOfEachScaleReproducesItsExtraction(@TempDir Path dir) throws Exception {
        RadiomicsMapEngine.LoadedVolume vol = RoiFeatureLogTest.volume(1.0, 1.0);
        RoiFeatureResult r = RoiFeatureLogTest.service(vol, dir).compute(
                req(Map.of(), List.of(3.0), null, null, null), p -> { });
        RoiFeatureResult.ScaleEntry e = r.scales().get(0);
        assertEquals(1.7321, e.sigma3dMm());
        Properties props = new Properties();
        props.load(new StringReader(e.result().settingsProperties()));
        assertEquals("1.7321", props.getProperty("DOUBLEARRAY_logSigmaMm"));
        ImagePlus mask = vol.mask();
        mask.setCalibration(vol.calibration().copy());
        ResultsTable direct = RadiomicsLock.call(() -> {
            try {
                RadiomicsJ rj = new RadiomicsJ();
                rj.loadSettings(props);
                return rj.extractAll(vol.image(), mask, 1);
            } finally {
                RadiomicsJ.resetSettings();
                RadiomicsJ.discretiseImp = null;
            }
        });
        Map<String, Double> mine = RoiFeatureLogTest.values(e.result().rows());
        int last = direct.size() - 1, compared = 0;
        for (String h : direct.getHeadings()) {
            if (!direct.columnExists(h)) continue;
            double d = direct.getValue(h, last);
            Double m = mine.get(h);
            if (Double.isNaN(d)) assertNull(m, h);
            else assertEquals(Double.doubleToLongBits(d), Double.doubleToLongBits(m), h);
            compared++;
        }
        assertEquals(mine.size(), compared);
    }

    @Test
    void cancelStopsAtTheScaleBoundaryAndKeepsFinishedScales(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(1.0, 1.0), dir);
        AtomicBoolean cancel = new AtomicBoolean();
        List<Double> started = new ArrayList<>();
        RoiFeatureRequest rq = req(Map.of(), List.of(0.0, 2.0, 3.0), null, null, null);
        assertThrows(CancellationException.class, () -> svc.compute(rq, p -> { }, (d, t) -> { }, cancel::get,
                (done, total, r) -> {
                    started.add(r);
                    if (done == 0) cancel.set(true); // 最初のスケールを始めた直後に取り消す
                }));
        assertEquals(List.of(0.0), started, "最初のスケールだけ始めた");
        RoiFeatureResult again = svc.compute(rq, p -> { });
        assertTrue(again.scales().get(0).result().fromCache(), "終えたスケールはキャッシュに入っている");
        assertFalse(again.scales().get(1).result().fromCache(), "残りは始めていない");
        assertFalse(again.scales().get(2).result().fromCache());
    }

    @Test
    void radiusAndSigmaCannotBeCombinedAndBadInputsAreRefused(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(1.0, 1.0), dir);
        IllegalArgumentException both = assertThrows(IllegalArgumentException.class, () -> svc.compute(
                req(Map.of("DOUBLEARRAY_logSigmaMm", "1.5"), List.of(2.0), null, null, null), p -> { }));
        assertTrue(both.getMessage().contains("同時"), both.getMessage());
        assertThrows(IllegalArgumentException.class,
                () -> svc.compute(req(Map.of(), List.of(-1.0), null, null, null), p -> { }));
        assertThrows(IllegalArgumentException.class,
                () -> svc.compute(req(Map.of(), List.of(2.0), "COEFFICIENT", null, null), p -> { }));
        assertThrows(IllegalArgumentException.class,
                () -> svc.compute(req(Map.of(), List.of(2.0), "NOPE", null, null), p -> { }));
    }

    @Test
    void twoDimensionalUnitsUseTheTwoDimensionalConversion(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(1.0, 1.0), dir);
        RoiFeatureResult r = svc.compute(req(Map.of(), List.of(4.0), null, null,
                EnumSet.of(RoiFeatureRequest.RoiMode.MAX_SECTION_2D)), p -> { });
        RoiFeatureResult.ScaleEntry e = r.scales().get(0);
        assertEquals(2.3094, e.sigma3dMm());
        assertEquals(2.8284, e.sigma2dMm());
        assertTrue(RoiFeatureLogTest.values(e.result().rows()).containsKey("log_sigma2.3094mm_" + MEAN));
        assertTrue(RoiFeatureLogTest.values(e.result().section().rows()).containsKey("log_sigma2.8284mm_" + MEAN));
    }
}
