/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** スライスの並びの判定（真値は手計算）。 */
class SliceLayoutTest {

    private static final double[] AXIAL = {1, 0, 0, 0, 1, 0};

    private static List<double[]> zs(double... z) {
        List<double[]> out = new ArrayList<>();
        for (double v : z) out.add(new double[]{-48, -50, v});
        return out;
    }

    private static double[] cum(double... steps) {
        double[] out = new double[steps.length + 1];
        for (int i = 0; i < steps.length; i++) out[i + 1] = out[i] + steps[i];
        return out;
    }

    @Test
    void uniform_usesTheMeanOfAllGaps_notTheFirstTwo() {
        // 先頭の 2 枚の間隔が 2.5、全体の平均も 2.5（一様）
        SliceLayout l = SliceLayout.of(zs(cum(2.5, 2.5, 2.5, 2.5)), AXIAL);
        assertEquals(SliceLayout.Kind.UNIFORM, l.kind());
        assertEquals(2.5, l.nominalSpacing(), 1e-12);
        assertTrue(l.isRegularGrid());
    }

    @Test
    void irregular_isNotARegularGrid_andFirstTwoWasNotRepresentative() {
        // 2.0, 3.5, 2.5, 3.0, 2.0, 3.5（平均 2.75）。旧式は先頭 2 枚の 2.0 を全体の間隔にしていた（0.73 倍の体積）
        SliceLayout l = SliceLayout.of(zs(cum(2.0, 3.5, 2.5, 3.0, 2.0, 3.5)), AXIAL);
        assertEquals(SliceLayout.Kind.IRREGULAR, l.kind());
        assertFalse(l.isRegularGrid());
        assertEquals(2.0, l.minGap(), 1e-12);
        assertEquals(3.5, l.maxGap(), 1e-12);
        assertTrue(l.irregularityMessage().contains("不規則"));
    }

    @Test
    void missingSlice_isDetectedWithItsCount() {
        // 2.5, 2.5, 5.0（1 枚欠け）, 2.5
        SliceLayout l = SliceLayout.of(zs(cum(2.5, 2.5, 5.0, 2.5)), AXIAL);
        assertEquals(SliceLayout.Kind.MISSING, l.kind());
        assertEquals(1, l.missingCount());
        assertEquals(2.5, l.nominalSpacing(), 1e-12, "欠損のとき公称は最小間隔");
        assertFalse(l.isRegularGrid());
    }

    @Test
    void reversedAndShuffledOrder_areSortedAlongTheNormal() {
        List<double[]> ipps = zs(cum(2.5, 2.5, 2.5, 2.5));
        Collections.reverse(ipps);
        assertEquals(SliceLayout.Kind.UNIFORM, SliceLayout.of(ipps, AXIAL).kind());
        List<double[]> shuffled = zs(5, 0, 10, 2.5, 7.5);
        SliceLayout l = SliceLayout.of(shuffled, AXIAL);
        assertEquals(SliceLayout.Kind.UNIFORM, l.kind());
        assertEquals(2.5, l.nominalSpacing(), 1e-12);
    }

    @Test
    void duplicates_areDetected() {
        assertEquals(SliceLayout.Kind.DUPLICATES, SliceLayout.of(zs(0, 2.5, 2.5, 5), AXIAL).kind());
    }

    @Test
    void ippRounding_isTolerated() {
        SliceLayout l = SliceLayout.of(zs(0 - 0.005, 2.5 + 0.005, 5.0 - 0.005, 7.5 + 0.005), AXIAL);
        assertEquals(SliceLayout.Kind.UNIFORM, l.kind());
    }

    @Test
    void tilt_isDetectedFromTheIppDirection_notFromTheSpacing() {
        // IOP は axial のまま、IPP が (0, 2.5·sin15°, 2.5·cos15°) ずつ進む（ガントリーチルト 15°）
        double t = Math.toRadians(15);
        List<double[]> ipps = new ArrayList<>();
        for (int k = 0; k < 6; k++) ipps.add(new double[]{0, 2.5 * Math.sin(t) * k, 2.5 * Math.cos(t) * k});
        SliceLayout l = SliceLayout.of(ipps, AXIAL);
        assertEquals(15.0, l.tiltDeg(), 1e-9);
        assertTrue(l.hasTilt());
        assertFalse(l.isRegularGrid());
        // 法線方向の間隔は 2.5·cos15° = 2.4148（一様）
        assertEquals(SliceLayout.Kind.UNIFORM, l.kind());
        assertEquals(2.5 * Math.cos(t), l.nominalSpacing(), 1e-9);
        assertTrue(l.irregularityMessage().contains("ガントリーチルト"));
    }

    @Test
    void scannerStyleTilt_iopTiltedAndIppAlongZ_isDetected() {
        // 実機のチルト CT の符号化: IOP の列方向が 23° 傾き、IPP は z に進む
        double t = Math.toRadians(23);
        double[] iop = {1, 0, 0, 0, Math.cos(t), -Math.sin(t)};
        List<double[]> ipps = new ArrayList<>();
        for (int k = 0; k < 6; k++) ipps.add(new double[]{0, 0, 5.4 * k});
        SliceLayout l = SliceLayout.of(ipps, iop);
        assertEquals(23.0, l.tiltDeg(), 1e-9);
        assertTrue(l.hasTilt());
    }

    @Test
    void parallelStepIsNotTilt_obliqueIop() {
        // 斜位 IOP（z 軸まわりの回転）で、IPP が法線（+z）方向に進む → チルトではない
        double[] iop = {0.9, 0.436, 0, -0.436, 0.9, 0};
        SliceLayout l = SliceLayout.of(zs(cum(2, 2, 2)), iop);
        assertFalse(l.hasTilt());
        assertTrue(l.isRegularGrid());
    }

    @Test
    void localGap_isTheLargerOfTheTwoNeighbouringGaps() {
        // 位置 0, 2.0, 5.5, 8.0（間隔 2.0, 3.5, 2.5）
        SliceLayout l = SliceLayout.of(zs(0, 2.0, 5.5, 8.0), AXIAL);
        assertEquals(2.0, l.localGap(0), 1e-12, "端は片側だけ");
        assertEquals(3.5, l.localGap(1), 1e-12);
        assertEquals(3.5, l.localGap(2), 1e-12);
        assertEquals(2.5, l.localGap(3), 1e-12);
        // 順不同の index でも位置で決まる
        SliceLayout sh = SliceLayout.of(zs(8.0, 0, 5.5, 2.0), AXIAL);
        assertEquals(2.5, sh.localGap(0), 1e-12);
        assertEquals(2.0, sh.localGap(1), 1e-12);
    }

    @Test
    void singleSliceAndUnknown() {
        assertEquals(SliceLayout.Kind.SINGLE, SliceLayout.of(zs(3), AXIAL).kind());
        assertTrue(SliceLayout.of(zs(3), AXIAL).isRegularGrid());
        List<double[]> withNull = zs(0, 2.5, 5);
        withNull.set(1, null);
        assertEquals(SliceLayout.Kind.UNKNOWN, SliceLayout.of(withNull, AXIAL).kind());
        assertEquals(SliceLayout.Kind.UNKNOWN, SliceLayout.of(zs(0, 2.5), null).kind());
    }
}
