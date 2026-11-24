/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import ij.ImagePlus;
import ij.process.ImageProcessor;

import java.util.Arrays;

/**
 * 値なし（NaN）を含む画像を Radiomics の入力にしてよいかの判定（画素だけを見る純関数）。
 *
 * <p>実測（RadiomicsJ 2.7.4、合成画像）: ROI の<b>内側</b>の NaN は全族の値を変え、一次統計の多くは NaN になる。
 * ROI の<b>外側</b>の NaN は、① ROI 特徴量では局所強度（LocalIntensityPeak・GlobalIntensityPeak）の 2 列だけを変える
 * （ROI から球半径 {@link #LOCAL_PEAK_RADIUS_MM} の近傍に届くとき。LocalIntensityPeak は 0.0 という静かに誤った値になる）、
 * ② マップでは窓が届く範囲にあると窓の値を静かに変え、届かなければ変えない。0・1000・NaN のどれで埋めても結果が
 * そろわないので、NaN を別の値に置き換えて計算することはしない。
 */
final class NanReach {

    private NanReach() {}

    /** 局所強度ピークの近傍の体積（IBSI: 1 cm³ の球）。 */
    static final double LOCAL_PEAK_VOLUME_MM3 = 1000.0;

    /** その球の半径 [mm] = (3V / 4π)^(1/3) ≈ 6.2 mm。画素間隔に依らない定義から実行時に導く。 */
    static final double LOCAL_PEAK_RADIUS_MM = Math.cbrt(3.0 * LOCAL_PEAK_VOLUME_MM3 / (4.0 * Math.PI));

    /** ROI の内（画素値 &gt;= 1。RadiomicsJ と同じ判定）の印。 */
    static boolean[][] insideOf(ImagePlus mask, int w, int h, int s) {
        boolean[][] in = new boolean[s][w * h];
        for (int z = 0; z < s; z++) {
            ImageProcessor ip = mask.getStack().getProcessor(z + 1);
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    in[z][y * w + x] = ip.getf(x, y) >= 1;
                }
            }
        }
        return in;
    }

    /** 画像の画素を [z][w*h] の float で（元の配列を共有しないコピー）。 */
    static float[][] slicesOf(ImagePlus img, int s) {
        float[][] out = new float[s][];
        for (int z = 0; z < s; z++) {
            out[z] = ((float[]) img.getStack().getProcessor(z + 1).convertToFloat().getPixels()).clone();
        }
        return out;
    }

    static long countNaN(float[][] img) {
        long n = 0;
        for (float[] s : img) {
            for (float v : s) {
                if (Float.isNaN(v)) n++;
            }
        }
        return n;
    }

    /** ROI の内側にある NaN の数。 */
    static long countNaNInside(float[][] img, boolean[][] roi) {
        long n = 0;
        for (int z = 0; z < img.length; z++) {
            for (int i = 0; i < img[z].length; i++) {
                if (roi[z][i] && Float.isNaN(img[z][i])) n++;
            }
        }
        return n;
    }

    /** ROI の外接箱 {x0,x1,y0,y1,z0,z1}（含む）。ROI が空なら null。 */
    private static int[] bbox(boolean[][] roi, int w, int h) {
        int x0 = Integer.MAX_VALUE, y0 = x0, z0 = x0, x1 = -1, y1 = -1, z1 = -1;
        for (int z = 0; z < roi.length; z++) {
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    if (roi[z][y * w + x]) {
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                        if (z < z0) z0 = z;
                        if (z > z1) z1 = z;
                    }
                }
            }
        }
        return x1 < 0 ? null : new int[] {x0, x1, y0, y1, z0, z1};
    }

    /**
     * ROI の外側の NaN が、ROI から各軸 {@code rx, ry, rz} 画素（箱）以内にあるか。ROI の内側の NaN は数えない。
     */
    static boolean nanWithinBox(float[][] img, boolean[][] roi, int w, int h, int rx, int ry, int rz) {
        return !candidates(img, roi, w, h, rx, ry, rz, false).isEmpty();
    }

    /**
     * ROI の外側の NaN が、ROI から楕円体（各軸の画素間隔 {@code dx, dy, dz} [mm]、半径 {@code radiusMm}）以内にあるか。
     * 箱で絞ったあと、近い順に並べた近傍を ROI の画素に当てて確かめる。
     */
    static boolean nanWithinMm(float[][] img, boolean[][] roi, int w, int h, double dx, double dy, double dz,
                               double radiusMm) {
        int rx = (int) Math.ceil(radiusMm / dx), ry = (int) Math.ceil(radiusMm / dy), rz = (int) Math.ceil(radiusMm / dz);
        Candidates c = candidates(img, roi, w, h, rx, ry, rz, true);
        if (c.isEmpty()) {
            return false;
        }
        // 球の近傍（近い順）。同じ距離の丸め誤差で取りこぼさないよう、わずかに広げる
        double r2 = radiusMm * radiusMm * (1 + 1e-9);
        int n = 0;
        int[][] off = new int[(2 * rx + 1) * (2 * ry + 1) * (2 * rz + 1)][];
        double[] dist = new double[off.length];
        for (int oz = -rz; oz <= rz; oz++) {
            for (int oy = -ry; oy <= ry; oy++) {
                for (int ox = -rx; ox <= rx; ox++) {
                    double d2 = sq(ox * dx) + sq(oy * dy) + sq(oz * dz);
                    if (d2 <= r2) {
                        off[n] = new int[] {ox, oy, oz};
                        dist[n++] = d2;
                    }
                }
            }
        }
        Integer[] order = new Integer[n];
        for (int i = 0; i < n; i++) order[i] = i;
        Arrays.sort(order, (a, b) -> Double.compare(dist[a], dist[b]));
        int nz = roi.length;
        for (int[] p : c.points()) {
            for (int k = 0; k < n; k++) {
                int[] o = off[order[k]];
                int x = p[0] + o[0], y = p[1] + o[1], z = p[2] + o[2];
                if (x >= 0 && x < w && y >= 0 && y < h && z >= 0 && z < nz && roi[z][y * w + x]) {
                    return true;
                }
            }
        }
        return false;
    }

    private static double sq(double v) {
        return v * v;
    }

    private record Candidates(java.util.List<int[]> points) {
        boolean isEmpty() {
            return points.isEmpty();
        }
    }

    /**
     * ROI を箱（{@code rx, ry, rz}）で膨らませた範囲にある、ROI の外側の NaN。{@code all} が false なら 1 つ見つけた時点で返す。
     * 外接箱の周りだけを調べ、膨らませは軸ごとに 1 次元の累積和で行う（O(体積)）。
     */
    private static Candidates candidates(float[][] img, boolean[][] roi, int w, int h, int rx, int ry, int rz,
                                         boolean all) {
        int nz = roi.length;
        int[] bb = bbox(roi, w, h);
        java.util.List<int[]> found = new java.util.ArrayList<>();
        if (bb == null) {
            return new Candidates(found);
        }
        int x0 = Math.max(0, bb[0] - rx), x1 = Math.min(w - 1, bb[1] + rx);
        int y0 = Math.max(0, bb[2] - ry), y1 = Math.min(h - 1, bb[3] + ry);
        int z0 = Math.max(0, bb[4] - rz), z1 = Math.min(nz - 1, bb[5] + rz);
        int sw = x1 - x0 + 1, sh = y1 - y0 + 1, sz = z1 - z0 + 1;
        boolean[] cur = new boolean[sw * sh * sz];
        for (int z = 0; z < sz; z++) {
            for (int y = 0; y < sh; y++) {
                for (int x = 0; x < sw; x++) {
                    cur[(z * sh + y) * sw + x] = roi[z0 + z][(y0 + y) * w + (x0 + x)];
                }
            }
        }
        cur = dilateAxis(cur, sw, sh, sz, 0, rx);
        cur = dilateAxis(cur, sw, sh, sz, 1, ry);
        cur = dilateAxis(cur, sw, sh, sz, 2, rz);
        for (int z = 0; z < sz; z++) {
            for (int y = 0; y < sh; y++) {
                for (int x = 0; x < sw; x++) {
                    int gi = (y0 + y) * w + (x0 + x);
                    if (cur[(z * sh + y) * sw + x] && !roi[z0 + z][gi] && Float.isNaN(img[z0 + z][gi])) {
                        found.add(new int[] {x0 + x, y0 + y, z0 + z});
                        if (!all) {
                            return new Candidates(found);
                        }
                    }
                }
            }
        }
        return new Candidates(found);
    }

    /** 1 軸の箱による膨らませ（±r）。 */
    private static boolean[] dilateAxis(boolean[] in, int sw, int sh, int sz, int axis, int r) {
        if (r <= 0) {
            return in;
        }
        boolean[] out = new boolean[in.length];
        int len = axis == 0 ? sw : axis == 1 ? sh : sz;
        int[] pre = new int[len + 1];
        int outer1 = axis == 0 ? sh : sw, outer2 = axis == 2 ? sh : sz;
        for (int b = 0; b < outer2; b++) {
            for (int a = 0; a < outer1; a++) {
                for (int i = 0; i < len; i++) {
                    pre[i + 1] = pre[i] + (in[index(axis, i, a, b, sw, sh)] ? 1 : 0);
                }
                for (int i = 0; i < len; i++) {
                    int lo = Math.max(0, i - r), hi = Math.min(len - 1, i + r);
                    out[index(axis, i, a, b, sw, sh)] = pre[hi + 1] - pre[lo] > 0;
                }
            }
        }
        return out;
    }

    /** 軸 {@code axis} 方向の位置 {@code i}、残りの 2 軸の位置 {@code a, b} から配列の添字。 */
    private static int index(int axis, int i, int a, int b, int sw, int sh) {
        return switch (axis) {
            case 0 -> (b * sh + a) * sw + i;   // a=y, b=z
            case 1 -> (b * sh + i) * sw + a;   // a=x, b=z
            default -> (i * sh + b) * sw + a;  // a=x, b=y
        };
    }

    // ───────────── 入口ごとの判定 ─────────────

    /** ROI 特徴量の入力としての NaN の状態。 */
    enum RoiNan {
        /** NaN なし。 */
        NONE,
        /** ROI の外だけにあり、局所強度の近傍にも届かない。全列がそのまま計算できる。 */
        OUTSIDE_FAR,
        /** ROI の外だけにあるが、局所強度の近傍（球）に届く。LocalIntensityPeak・GlobalIntensityPeak だけ値が決まらない。 */
        OUTSIDE_NEAR,
        /** ROI の内側にある。計算しない。 */
        INSIDE
    }

    static RoiNan assessForRoi(float[][] img, boolean[][] roi, int w, int h, double dx, double dy, double dz) {
        if (countNaN(img) == 0) {
            return RoiNan.NONE;
        }
        if (countNaNInside(img, roi) > 0) {
            return RoiNan.INSIDE;
        }
        return nanWithinMm(img, roi, w, h, dx, dy, dz, LOCAL_PEAK_RADIUS_MM) ? RoiNan.OUTSIDE_NEAR : RoiNan.OUTSIDE_FAR;
    }

    /** マップの入力としての NaN の状態。 */
    enum MapNan { NONE, OUTSIDE_FAR, INSIDE, REACHED }

    /**
     * マップの窓が ROI の外へ届く画素数（各軸）。窓はカーネルの半径まで、切り出す範囲は余白までなので、小さいほう。
     */
    static int mapReachVoxels(int kernel, int margin) {
        return Math.max(0, Math.min(kernel / 2, margin));
    }

    static MapNan assessForMap(float[][] img, boolean[][] roi, int w, int h, int kernel, int margin, boolean force2D) {
        if (countNaN(img) == 0) {
            return MapNan.NONE;
        }
        if (countNaNInside(img, roi) > 0) {
            return MapNan.INSIDE;
        }
        int r = mapReachVoxels(kernel, margin);
        return nanWithinBox(img, roi, w, h, r, r, force2D ? 0 : r) ? MapNan.REACHED : MapNan.OUTSIDE_FAR;
    }
}
