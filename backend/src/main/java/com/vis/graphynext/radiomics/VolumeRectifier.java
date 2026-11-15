/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.util.List;

/**
 * 不等間隔・欠損・ガントリーチルトのスライス群を、直交・等間隔の格子へ取り直す。純粋 Java。
 *
 * <p>出力格子の軸は（列方向 {@code rc}, 行方向 {@code rr}, 法線 {@code n}）、間隔は（dx, dy, dz）。
 * 出力ボクセルの患者座標 P について、法線位置 t を挟む 2 枚のソース（t_k1 ≤ t ≤ t_k2）それぞれで、
 * **そのスライス自身の IPP を原点とした面内座標** {@code ((P−IPP)·rc/dx, (P−IPP)·rr/dy)} を求めて面内を双一次補間し、
 * t で線形補間する。こうすると
 * <ul>
 *   <li>欠損・不規則な間隔 = 奥行き方向の線形補間（ビューアの {@code interpolateToGrid} と同じ）、</li>
 *   <li>ガントリーチルト（スライスごとに面内の位置がずれていく）= 面内のずれの吸収（ビューアの
 *       {@code gantryTiltCorrect} と同じ結果）</li>
 * </ul>
 * が同じ式で扱える。面内の出力範囲は、スライスごとのずれの和集合を覆うように広げる（画像の外は端の画素で埋め、
 * マスクは 0）。マスクは**最近傍**で取り直す（ラベルを混ぜない）。
 */
final class VolumeRectifier {

    /** 取り直し後のボクセル数がソースのこの倍率を超えたら断る（黙って何十分も待たせないため）。 */
    static final double MAX_VOXEL_GROWTH = 4.0;

    record Result(float[][] slices, byte[][] mask, int width, int height, int nSlices, double dz) {}

    private VolumeRectifier() {}

    /**
     * @param src   ソースの各スライス（w*h、行優先。index 順）
     * @param mask  ソースと同じ並びのマスク（無ければ null）。0 以外をラベルとして最近傍で取り直す
     * @param ipps  各スライスの IPP（すべて非 null）
     * @param iop   ImageOrientationPatient（6 要素）
     * @param dx    列方向の画素間隔 [mm]、dy 行方向 [mm]
     * @param dz    出力のスライス間隔 [mm]（通常は最小間隔）
     */
    static Result rectify(float[][] src, byte[][] mask, int w, int h, double dx, double dy, double[] iop,
                          List<double[]> ipps, double dz) {
        int n = src.length;
        if (n < 2) throw new IllegalArgumentException("スライスが 2 枚未満です");
        double[] nrm = SliceLayout.normalOf(iop);
        if (nrm == null) throw new IllegalArgumentException("ImageOrientationPatient が不正です");
        double[] rc = {iop[0], iop[1], iop[2]};
        double[] rr = {iop[3], iop[4], iop[5]};

        // 法線位置で並べ替える。
        double[] t = new double[n];
        Integer[] order = new Integer[n];
        for (int k = 0; k < n; k++) {
            double[] p = ipps.get(k);
            t[k] = dot(p, nrm);
            order[k] = k;
        }
        java.util.Arrays.sort(order, (a, b) -> Double.compare(t[a], t[b]));
        double[] ts = new double[n];
        for (int i = 0; i < n; i++) ts[i] = t[order[i]];
        double[] base = ipps.get(order[0]);

        // 各スライスの面内のずれ（先頭スライスの IPP を原点とする mm）。
        double[] a = new double[n], b = new double[n];
        double aMin = 0, aMax = 0, bMin = 0, bMax = 0;
        for (int i = 0; i < n; i++) {
            double[] p = ipps.get(order[i]);
            double[] d = {p[0] - base[0], p[1] - base[1], p[2] - base[2]};
            a[i] = dot(d, rc);
            b[i] = dot(d, rr);
            aMin = Math.min(aMin, a[i]);
            aMax = Math.max(aMax, a[i]);
            bMin = Math.min(bMin, b[i]);
            bMax = Math.max(bMax, b[i]);
        }
        int outW = w + (int) Math.ceil((aMax - aMin) / dx - 1e-9);
        int outH = h + (int) Math.ceil((bMax - bMin) / dy - 1e-9);
        int outN = (int) Math.floor((ts[n - 1] - ts[0]) / dz + 1e-6) + 1;
        double growth = (double) outW * outH * outN / ((double) w * h * n);
        if (growth > MAX_VOXEL_GROWTH) {
            throw new IllegalArgumentException(String.format(
                    "取り直すとボクセル数が %.1f 倍になるため計算できません（上限 %.0f 倍）。", growth, MAX_VOXEL_GROWTH));
        }
        // 出力の (0,0) の面内位置 = 先頭スライス原点から (aMin, bMin) mm。
        float[][] out = new float[outN][outW * outH];
        byte[][] outMask = mask == null ? null : new byte[outN][outW * outH];

        int seg = 0; // ts[seg] <= t < ts[seg+1]
        for (int m = 0; m < outN; m++) {
            double tm = ts[0] + m * dz;
            while (seg < n - 2 && tm > ts[seg + 1] + 1e-9) seg++;
            int i1 = seg, i2 = seg + 1;
            double span = ts[i2] - ts[i1];
            double w2 = span > 0 ? Math.min(1.0, Math.max(0.0, (tm - ts[i1]) / span)) : 0.0;
            float[] s1 = src[order[i1]], s2 = src[order[i2]];
            // マスク: 最も近いソースのスライス（半間隔以内のときだけ）。
            int near = (w2 < 0.5) ? i1 : i2;
            double dist = Math.abs(tm - ts[near]);
            double half = 0.5 * Math.max(near > 0 ? ts[near] - ts[near - 1] : 0, near < n - 1 ? ts[near + 1] - ts[near] : 0);
            byte[] msk = (mask != null && dist <= half + 1e-9) ? mask[order[near]] : null;
            for (int j = 0; j < outH; j++) {
                double v = bMin + j * dy;
                for (int i = 0; i < outW; i++) {
                    double u = aMin + i * dx;
                    // スライス i1 / i2 自身の面内座標
                    double x1 = (u - a[i1]) / dx, y1 = (v - b[i1]) / dy;
                    double x2 = (u - a[i2]) / dx, y2 = (v - b[i2]) / dy;
                    float p1 = bilinear(s1, w, h, x1, y1);
                    float p2 = bilinear(s2, w, h, x2, y2);
                    out[m][j * outW + i] = (float) ((1 - w2) * p1 + w2 * p2);
                    if (msk != null) {
                        int xn = near == i1 ? (int) Math.round(x1) : (int) Math.round(x2);
                        int yn = near == i1 ? (int) Math.round(y1) : (int) Math.round(y2);
                        if (xn >= 0 && yn >= 0 && xn < w && yn < h) outMask[m][j * outW + i] = msk[yn * w + xn];
                    }
                }
            }
        }
        return new Result(out, outMask, outW, outH, outN, dz);
    }

    /** 双一次補間。画像の外は端の画素で埋める。 */
    private static float bilinear(float[] px, int w, int h, double x, double y) {
        double xc = Math.min(Math.max(x, 0), w - 1), yc = Math.min(Math.max(y, 0), h - 1);
        int x0 = (int) Math.floor(xc), y0 = (int) Math.floor(yc);
        int x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
        double fx = xc - x0, fy = yc - y0;
        double c0 = px[y0 * w + x0] * (1 - fx) + px[y0 * w + x1] * fx;
        double c1 = px[y1 * w + x0] * (1 - fx) + px[y1 * w + x1] * fx;
        return (float) (c0 * (1 - fy) + c1 * fy);
    }

    private static double dot(double[] a, double[] b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }
}
