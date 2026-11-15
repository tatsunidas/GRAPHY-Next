/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 取り直しの真値は、患者座標の線形場 v = A·x + B·y + C·z + D（補間で厳密に再現される）と、ラベルの位置から手計算する。
 */
class VolumeRectifierTest {

    private static final double A = 0.5, B = -0.25, C = 0.125, D = 100;
    private static final int W = 30, H = 20;
    private static final double DX = 0.6, DY = 0.9;

    private static double field(double[] p) {
        return A * p[0] + B * p[1] + C * p[2] + D;
    }

    private static double[] pos(double[] ipp, double[] iop, double i, double j) {
        return new double[]{
                ipp[0] + i * DX * iop[0] + j * DY * iop[3],
                ipp[1] + i * DX * iop[1] + j * DY * iop[4],
                ipp[2] + i * DX * iop[2] + j * DY * iop[5]};
    }

    private static float[][] slicesOf(List<double[]> ipps, double[] iop) {
        float[][] s = new float[ipps.size()][W * H];
        for (int k = 0; k < s.length; k++)
            for (int j = 0; j < H; j++)
                for (int i = 0; i < W; i++) s[k][j * W + i] = (float) field(pos(ipps.get(k), iop, i, j));
        return s;
    }

    private static List<double[]> axialIpps(double... z) {
        List<double[]> out = new ArrayList<>();
        for (double v : z) out.add(new double[]{-10, -8, v});
        return out;
    }

    private static final double[] AXIAL = {1, 0, 0, 0, 1, 0};

    /** 出力の全ボクセルのうち、両側のソースの面内座標が画像内にあるものが、場の値と一致する。 */
    private static int checkAgainstField(VolumeRectifier.Result r, float[][] src, List<double[]> ipps, double[] iop, double dz) {
        double[] n = SliceLayout.normalOf(iop);
        double[] sorted = ipps.stream().mapToDouble(p -> p[0] * n[0] + p[1] * n[1] + p[2] * n[2]).sorted().toArray();
        double t0 = sorted[0];
        // 先頭スライス（法線位置が最小）の IPP
        double[] base = ipps.stream().min((p, q) -> Double.compare(p[0] * n[0] + p[1] * n[1] + p[2] * n[2],
                q[0] * n[0] + q[1] * n[1] + q[2] * n[2])).get();
        // 出力の面内原点の位置は結果から逆算できないので、(0,0) の値から原点を確認する代わりに、
        // 出力 (i,j) の患者座標を (u,v) = 先頭原点 + オフセットで測り、場の値と比べる。オフセットは再計算する。
        double aMin = 0, bMin = 0;
        for (double[] p : ipps) {
            double[] d = {p[0] - base[0], p[1] - base[1], p[2] - base[2]};
            aMin = Math.min(aMin, d[0] * iop[0] + d[1] * iop[1] + d[2] * iop[2]);
            bMin = Math.min(bMin, d[0] * iop[3] + d[1] * iop[4] + d[2] * iop[5]);
        }
        int checked = 0;
        for (int m = 0; m < r.nSlices(); m++) {
            double tm = t0 + m * dz;
            for (int j = 0; j < r.height(); j++) {
                for (int i = 0; i < r.width(); i++) {
                    double u = aMin + i * DX, v = bMin + j * DY;
                    double[] p = {base[0] + u * iop[0] + v * iop[3] + (tm - t0) * n[0],
                            base[1] + u * iop[1] + v * iop[4] + (tm - t0) * n[1],
                            base[2] + u * iop[2] + v * iop[5] + (tm - t0) * n[2]};
                    if (insideBothNeighbours(p, ipps, iop, n, tm)) {
                        assertEquals(field(p), r.slices()[m][j * r.width() + i], 2e-3, "m=" + m + " j=" + j + " i=" + i);
                        checked++;
                    }
                }
            }
        }
        return checked;
    }

    /** t を挟む 2 枚のソースの面内座標が、どちらも画像の内側（端の埋めを使わない）か。 */
    private static boolean insideBothNeighbours(double[] p, List<double[]> ipps, double[] iop, double[] n, double t) {
        double lo = -Double.MAX_VALUE, hi = Double.MAX_VALUE;
        double[] loIpp = null, hiIpp = null;
        for (double[] q : ipps) {
            double tq = q[0] * n[0] + q[1] * n[1] + q[2] * n[2];
            if (tq <= t + 1e-9 && tq > lo) { lo = tq; loIpp = q; }
            if (tq >= t - 1e-9 && tq < hi) { hi = tq; hiIpp = q; }
        }
        if (loIpp == null || hiIpp == null) return false;
        for (double[] q : new double[][]{loIpp, hiIpp}) {
            double[] d = {p[0] - q[0], p[1] - q[1], p[2] - q[2]};
            double x = (d[0] * iop[0] + d[1] * iop[1] + d[2] * iop[2]) / DX;
            double y = (d[0] * iop[3] + d[1] * iop[4] + d[2] * iop[5]) / DY;
            if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return false;
        }
        return true;
    }

    @Test
    void uniformWithoutTilt_isTheIdentity() {
        List<double[]> ipps = axialIpps(0, 2.5, 5, 7.5, 10);
        float[][] src = slicesOf(ipps, AXIAL);
        VolumeRectifier.Result r = VolumeRectifier.rectify(src, null, W, H, DX, DY, AXIAL, ipps, 2.5);
        assertEquals(W, r.width());
        assertEquals(H, r.height());
        assertEquals(5, r.nSlices());
        for (int k = 0; k < 5; k++) for (int q = 0; q < W * H; q++) assertEquals(src[k][q], r.slices()[k][q], 1e-4);
    }

    @Test
    void irregularSpacing_isInterpolatedOntoTheMinimumSpacingGrid() {
        // 2.0, 3.5, 2.5, 3.0 の不等間隔 → dz = 2.0 の格子。値は線形場なので補間で厳密に再現される。
        List<double[]> ipps = axialIpps(0, 2.0, 5.5, 8.0, 11.0);
        float[][] src = slicesOf(ipps, AXIAL);
        VolumeRectifier.Result r = VolumeRectifier.rectify(src, null, W, H, DX, DY, AXIAL, ipps, 2.0);
        assertEquals(6, r.nSlices(), "floor(11 / 2) + 1");
        assertTrue(checkAgainstField(r, src, ipps, AXIAL, 2.0) > W * H * 5);
    }

    @Test
    void missingSlice_isFilledByLinearInterpolation() {
        List<double[]> ipps = axialIpps(0, 2.5, 7.5, 10);
        float[][] src = slicesOf(ipps, AXIAL);
        VolumeRectifier.Result r = VolumeRectifier.rectify(src, null, W, H, DX, DY, AXIAL, ipps, 2.5);
        assertEquals(5, r.nSlices());
        assertTrue(checkAgainstField(r, src, ipps, AXIAL, 2.5) > W * H * 4);
    }

    @Test
    void reversedOrder_givesTheSameVolume() {
        List<double[]> ipps = axialIpps(0, 2.0, 5.5, 8.0, 11.0);
        float[][] src = slicesOf(ipps, AXIAL);
        VolumeRectifier.Result a = VolumeRectifier.rectify(src, null, W, H, DX, DY, AXIAL, ipps, 2.0);
        List<double[]> rev = new ArrayList<>(ipps);
        java.util.Collections.reverse(rev);
        float[][] revSrc = new float[src.length][];
        for (int k = 0; k < src.length; k++) revSrc[k] = src[src.length - 1 - k];
        VolumeRectifier.Result b = VolumeRectifier.rectify(revSrc, null, W, H, DX, DY, AXIAL, rev, 2.0);
        assertEquals(a.nSlices(), b.nSlices());
        for (int m = 0; m < a.nSlices(); m++) for (int q = 0; q < a.width() * a.height(); q++)
            assertEquals(a.slices()[m][q], b.slices()[m][q], 1e-4);
    }

    @Test
    void gantryTilt_isUndoneByTheInPlaneShift() {
        // IOP は axial、IPP が (0, 2.5·sin15°, 2.5·cos15°) ずつ進む。法線方向の間隔は 2.5·cos15°
        double t = Math.toRadians(15);
        List<double[]> ipps = new ArrayList<>();
        for (int k = 0; k < 8; k++) ipps.add(new double[]{-10, -8 + 2.5 * Math.sin(t) * k, 2.5 * Math.cos(t) * k});
        float[][] src = slicesOf(ipps, AXIAL);
        double dz = 2.5 * Math.cos(t);
        VolumeRectifier.Result r = VolumeRectifier.rectify(src, null, W, H, DX, DY, AXIAL, ipps, dz);
        assertEquals(8, r.nSlices());
        // 面内（行方向）が、ずれの和集合ぶん広がる: 7 × 2.5·sin15° = 4.53 mm → ceil(4.53/0.9) = 6 行
        assertEquals(H + 6, r.height());
        assertEquals(W, r.width());
        assertTrue(checkAgainstField(r, src, ipps, AXIAL, dz) > W * H * 6);
    }

    @Test
    void scannerStyleTilt_iopTiltedAndIppAlongZ() {
        // 実機型: IOP の列方向が 20° 傾き、IPP は z に進む（法線は z から 20° 傾く）
        double t = Math.toRadians(20);
        double[] iop = {1, 0, 0, 0, Math.cos(t), -Math.sin(t)};
        List<double[]> ipps = new ArrayList<>();
        for (int k = 0; k < 8; k++) ipps.add(new double[]{-10, -8, 3.0 * k});
        float[][] src = slicesOf(ipps, iop);
        SliceLayout l = SliceLayout.of(ipps, iop);
        assertTrue(l.hasTilt());
        double dz = l.nominalSpacing();
        VolumeRectifier.Result r = VolumeRectifier.rectify(src, null, W, H, DX, DY, iop, ipps, dz);
        assertTrue(checkAgainstField(r, src, ipps, iop, dz) > W * H * 5);
    }

    @Test
    void mask_isResampledByNearestAndOutsideIsZero() {
        List<double[]> ipps = axialIpps(0, 2.0, 5.5, 8.0, 11.0);
        float[][] src = slicesOf(ipps, AXIAL);
        byte[][] mask = new byte[5][W * H];
        for (int k = 1; k <= 3; k++)
            for (int j = 5; j < 10; j++) for (int i = 10; i < 20; i++) mask[k][j * W + i] = 7;
        VolumeRectifier.Result r = VolumeRectifier.rectify(src, mask, W, H, DX, DY, AXIAL, ipps, 2.0);
        // 値はラベル 7 と 0 だけ（混ざらない）
        boolean any = false;
        for (byte[] sl : r.mask()) for (byte b : sl) { assertTrue(b == 0 || b == 7); any |= b == 7; }
        assertTrue(any);
        // 最初と最後の出力スライス（ソースのマスクが空）は空
        for (byte b : r.mask()[0]) assertEquals(0, b);
        for (byte b : r.mask()[r.nSlices() - 1]) assertEquals(0, b);
    }

    @Test
    void tooMuchGrowth_isRefused() {
        // 2 枚だけで間隔 100 mm、dz = 0.5 mm → 200 倍
        List<double[]> ipps = axialIpps(0, 100);
        float[][] src = slicesOf(ipps, AXIAL);
        assertThrows(IllegalArgumentException.class,
                () -> VolumeRectifier.rectify(src, null, W, H, DX, DY, AXIAL, ipps, 0.5));
    }
}
