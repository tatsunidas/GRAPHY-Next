/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** ROI 特徴量: スケールの書き方（幅（画素）・名札）。 */
class RoiFeatureScaleNotationTest {

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    private static RoiFeatureRequest req(List<Double> scales, String notation, List<String> labels) {
        return new RoiFeatureRequest("1.2", "1.2.9", "1.2.8", 0, 0, 0, Map.of(), false, null,
                scales, notation, labels, null, null);
    }

    private static void assertSameRows(RoiFeatureResult a, RoiFeatureResult b) {
        assertEquals(a.rows().size(), b.rows().size());
        for (int i = 0; i < a.rows().size(); i++) {
            Double x = a.rows().get(i).value(), y = b.rows().get(i).value();
            assertEquals(a.rows().get(i).column(), b.rows().get(i).column());
            if (x == null) assertNull(y);
            else assertEquals(Double.doubleToLongBits(x), Double.doubleToLongBits(y), a.rows().get(i).column());
        }
    }

    private static Double logMean(RoiFeatureResult r) {
        return r.rows().stream()
                .filter(x -> x.column().startsWith("log_sigma") && x.column().endsWith("_IntensityBasedStatistical_Mean"))
                .findFirst().get().value();
    }

    @Test
    void widthInPixelsIsTheSameAsTheDirectRadiusBitForBit(@TempDir Path d1, @TempDir Path d2) throws Exception {
        // 別々のキャッシュで計算する（同じキャッシュだと、同じ σ は 2 回目がキャッシュから返って自明に一致する）
        RoiFeatureResult w = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(0.98, 0.98), d1)
                .compute(req(List.of(4.0), "WIDTH_PX", null), p -> { });
        RoiFeatureResult r = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(0.98, 0.98), d2)
                .compute(req(List.of(1.96), "RADIUS_MM", null), p -> { });
        RoiFeatureResult.ScaleEntry we = w.scales().get(0);
        assertEquals(1.96, we.scaleMm(), 1e-12, "幅 4 画素 × 0.98 mm / 2");
        assertEquals("width_px", we.inputNotation());
        assertEquals(4.0, we.inputValue());
        assertEquals(0.98, we.pixelSpacingMm());
        assertFalse(r.scales().get(0).result().fromCache());
        assertSameRows(we.result(), r.scales().get(0).result());
        assertEquals("radius_mm", r.scales().get(0).inputNotation());
        assertNull(r.scales().get(0).pixelSpacingMm());
        // 負例: 別の半径なら一致しない
        RoiFeatureResult other = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(0.98, 0.98), d1.resolve("o"))
                .compute(req(List.of(2.5), "RADIUS_MM", null), p -> { });
        assertNotEquals(logMean(we.result()), logMean(other.scales().get(0).result()));
    }

    @Test
    void theSameWidthIsADifferentLengthWhenThePixelsAreDifferent(@TempDir Path dir) throws Exception {
        RoiFeatureResult r = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(0.5, 0.5), dir)
                .compute(req(List.of(4.0), "WIDTH_PX", null), p -> { });
        assertEquals(1.0, r.scales().get(0).scaleMm(), 1e-12);
        assertEquals(0.5, r.scales().get(0).pixelSpacingMm());
    }

    @Test
    void widthIsRefusedWhenRowAndColumnSpacingDiffer(@TempDir Path dir) {
        RadiomicsMapEngine.LoadedVolume vol = RoiFeatureLogTest.volume(0.7, 0.7);
        vol.calibration().pixelHeight = 0.9;
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () ->
                RoiFeatureLogTest.service(vol, dir).compute(req(List.of(4.0), "WIDTH_PX", null), p -> { }));
        assertTrue(e.getMessage().contains("縦横") && e.getMessage().contains("0.700") && e.getMessage().contains("0.900"),
                e.getMessage());
        // 対照: 半径（mm）なら同じ画像で指定できる。縦横の間隔が違うと LoG は等方でないので別の理由で断られうるが、
        // 「画素幅」の検査には当たらない
        IllegalArgumentException r = assertThrows(IllegalArgumentException.class, () ->
                RoiFeatureLogTest.service(vol, dir).compute(req(List.of(2.0), "RADIUS_MM", null), p -> { }));
        assertFalse(r.getMessage().contains("画素幅"), r.getMessage());
    }

    @Test
    void labelsAreRecordedButNeverUsedForTheComputation(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(1.0, 1.0), dir);
        RoiFeatureResult a = svc.compute(req(List.of(2.0, 3.0), "RADIUS_MM", List.of("1.0", "")), p -> { });
        assertEquals("1.0", a.scales().get(0).legacyLabel());
        assertNull(a.scales().get(1).legacyLabel(), "空の名札は無し");
        // 名札を変えても計算は同じ（キャッシュから返る）
        RoiFeatureResult b = svc.compute(req(List.of(2.0, 3.0), "RADIUS_MM", List.of("x", "y")), p -> { });
        assertTrue(b.scales().get(0).result().fromCache());
        assertEquals("x", b.scales().get(0).legacyLabel());
        // 負例: 数が合わない名札は断る
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () ->
                svc.compute(req(List.of(2.0, 3.0), "RADIUS_MM", List.of("1.0")), p -> { }));
        assertTrue(e.getMessage().contains("名札"), e.getMessage());
    }

    @Test
    void duplicateValuesAndRadiiAreMerged(@TempDir Path dir) throws Exception {
        RoiFeatureService svc = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(0.5, 0.5), dir);
        assertEquals(1, svc.compute(req(List.of(2.0, 2.0), "RADIUS_MM", null), p -> { }).scales().size());
        // 幅 4 画素＠0.5 mm = r 1.0 mm と r 1.0 は同じ長さ
        assertEquals(1, svc.compute(req(List.of(4.0, 4.0), "WIDTH_PX", null), p -> { }).scales().size());
    }

    @Test
    void badNotationAndNegativeWidthAreRefused(@TempDir Path dir) {
        RoiFeatureService svc = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(1.0, 1.0), dir);
        assertThrows(IllegalArgumentException.class, () -> svc.compute(req(List.of(2.0), "NOPE", null), p -> { }));
        assertThrows(IllegalArgumentException.class, () -> svc.compute(req(List.of(-4.0), "WIDTH_PX", null), p -> { }));
    }

    @Test
    void zeroWidthMeansNoFilter(@TempDir Path dir) throws Exception {
        RoiFeatureResult r = RoiFeatureLogTest.service(RoiFeatureLogTest.volume(1.0, 1.0), dir)
                .compute(req(List.of(0.0, 4.0), "WIDTH_PX", null), p -> { });
        assertNull(r.scales().get(0).sigma3dMm());
        assertEquals(2.0, r.scales().get(1).scaleMm(), 1e-12);
    }
}
