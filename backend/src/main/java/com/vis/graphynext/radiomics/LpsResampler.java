/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;

import java.util.HashMap;
import java.util.Map;

/**
 * 体積を、患者座標（LPS）の軸に揃った断面（Axial・Sagittal・Coronal）へ再スライスする。純粋 Java（画素・スライス番号の計算は
 * この中に閉じ込め、外へは実座標の体積として返す）。
 *
 * <ul>
 * <li>断面の標準の向き: AXIAL は行 +x・列 +y・法線 +z（IOP 1,0,0,0,1,0）、SAGITTAL は行 +y・列 −z・法線 −x（0,1,0,0,0,−1）、
 *     CORONAL は行 +x・列 −z・法線 +y（1,0,0,0,0,−1）。位置（{@link ImagePlane}）は患者軸の座標そのものになる。</li>
 * <li>格子は、元の体積の原点（先頭スライスの先頭画素の中心）から {@code spacing} ごとの格子点（等方）。元の面と同じ軸で
 *     間隔も同じなら、格子点が元の画素の中心に一致し、元のスライスをそのまま返す（補間は恒等）。</li>
 * <li>画像は三線形補間（体積の外は端の値）。マスクは 0/1 に直して三線形補間し、しきい値（既定 0.5、RadiomicsJ の部分体積の
 *     しきい値と同じ考え方）以上をラベルにする（体積の外は 0）。</li>
 * <li>範囲は ROI の外接の範囲＋1 画素。スライスの位置は ROI の範囲を覆う格子点。</li>
 * </ul>
 * 元の体積は、直交・等間隔の格子（取り直した体積を含む）で、先頭スライスの原点が分かっていること。
 */
final class LpsResampler {

    /** 1 つの断面の体積のボクセル数の上限（黙って何十分も待たせないため）。 */
    static final long MAX_VOXELS = 50_000_000L;

    private LpsResampler() {}

    /** 断面の標準の向き（行・列の軸と向き、法線の軸、IOP）。 */
    record Axes(String name, int rowAxis, int colAxis, int colSign, int normalAxis, double[] iop) {}

    static Axes axesOf(String plane) {
        return switch (plane) {
            case ImagePlane.AXIAL -> new Axes(plane, 0, 1, +1, 2, new double[] {1, 0, 0, 0, 1, 0});
            case ImagePlane.SAGITTAL -> new Axes(plane, 1, 2, -1, 0, new double[] {0, 1, 0, 0, 0, -1});
            case ImagePlane.CORONAL -> new Axes(plane, 0, 2, -1, 1, new double[] {1, 0, 0, 0, 0, -1});
            default -> throw new IllegalArgumentException("不明な断面です: " + plane);
        };
    }

    /**
     * @param src           元の体積（{@code originLps}・{@code normalPositionsMm}・向き・間隔が要る）
     * @param label         ROI のラベル値
     * @param plane         {@link ImagePlane#AXIAL}・{@link ImagePlane#SAGITTAL}・{@link ImagePlane#CORONAL}
     * @param spacing       面内と法線方向の間隔（mm、等方）
     * @param maskThreshold マスクの三線形補間値のしきい値（0〜1）
     * @return その断面の体積。スライスは患者軸の正の向きへ進む（Sagittal・Coronal の IOP の法線は負の軸向きなので、{@code normalPositionsMm}（IPP·法線）は降順になる）
     * @throws IllegalArgumentException 再スライスできない（原点・位置が不明、1 枚だけ、不等間隔、ROI が空、大きすぎる）
     */
    static RadiomicsMapEngine.LoadedVolume reslice(RadiomicsMapEngine.LoadedVolume src, int label, String plane,
                                                   double spacing, double maskThreshold) {
        if (!(spacing > 0)) {
            throw new IllegalArgumentException("断面の間隔は正の数にしてください。");
        }
        double[] o = src.originLps();
        double[] t = src.normalPositionsMm();
        double[] iop = src.imageOrientationPatient();
        double[] en = RadiomicsMapEngine.normalOf(iop);
        Calibration cal = src.calibration();
        if (o == null || t == null || en == null || cal == null || t.length != src.slices()) {
            throw new IllegalArgumentException("画像の位置（原点・スライスの位置）が分からないため、断面を作れません。");
        }
        int w = src.width(), h = src.height(), n = src.slices();
        if (n < 2) {
            throw new IllegalArgumentException("スライスが 1 枚だけのため、別の断面を作れません。");
        }
        double dx = cal.pixelWidth, dy = cal.pixelHeight;
        if (!(dx > 0 && dy > 0)) {
            throw new IllegalArgumentException("画素間隔が不明なため、断面を作れません。");
        }
        double dt = (t[n - 1] - t[0]) / (n - 1);
        for (int k = 0; k < n; k++) {
            if (Math.abs(t[k] - (t[0] + k * dt)) > 1e-3 * Math.abs(dt)) {
                throw new IllegalArgumentException("スライスが等間隔でないため、断面を作れません（取り直しを使ってください）。");
            }
        }
        double[] ex = {iop[0], iop[1], iop[2]};
        double[] ey = {iop[3], iop[4], iop[5]};

        // 元の体積を float 配列へ（マスクは ROI のラベルだけ 1）
        float[][] img = new float[n][];
        float[][] msk = new float[n][];
        long roiVoxels = 0;
        double[] lo = {Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE};
        double[] hi = {-Double.MAX_VALUE, -Double.MAX_VALUE, -Double.MAX_VALUE};
        for (int k = 0; k < n; k++) {
            img[k] = ((float[]) src.image().getStack().getProcessor(k + 1).convertToFloatProcessor().getPixels()).clone();
            float[] mp = (float[]) src.mask().getStack().getProcessor(k + 1).convertToFloatProcessor().getPixels();
            msk[k] = new float[w * h];
            for (int j = 0; j < h; j++) {
                for (int i = 0; i < w; i++) {
                    if ((int) mp[j * w + i] == label) {
                        msk[k][j * w + i] = 1f;
                        roiVoxels++;
                        for (int a = 0; a < 3; a++) {
                            double c = o[a] + i * dx * ex[a] + j * dy * ey[a] + k * dt * en[a];
                            lo[a] = Math.min(lo[a], c);
                            hi[a] = Math.max(hi[a], c);
                        }
                    }
                }
            }
        }
        if (roiVoxels == 0) {
            throw new IllegalArgumentException("ROI が空です。マスクシリーズ・セグメント・ラベル値を確認してください。");
        }

        Axes ax = axesOf(plane);
        int[] mLo = new int[3], mHi = new int[3];
        for (int a = 0; a < 3; a++) {
            mLo[a] = (int) Math.floor((lo[a] - spacing - o[a]) / spacing);
            mHi[a] = (int) Math.ceil((hi[a] + spacing - o[a]) / spacing);
        }
        int nr = mHi[ax.rowAxis()] - mLo[ax.rowAxis()] + 1;
        int nc = mHi[ax.colAxis()] - mLo[ax.colAxis()] + 1;
        int nn = mHi[ax.normalAxis()] - mLo[ax.normalAxis()] + 1;
        if ((long) nr * nc * nn > MAX_VOXELS || nr < 1 || nc < 1 || nn < 1) {
            throw new IllegalArgumentException(String.format(
                    "断面の体積が大きすぎて作れません（%d×%d×%d ボクセル。上限 %,d）。間隔を粗くしてください。", nr, nc, nn, MAX_VOXELS));
        }

        double[] pn = RadiomicsMapEngine.normalOf(ax.iop());
        ImageStack is = new ImageStack(nr, nc);
        ImageStack ms = new ImageStack(nr, nc);
        double[] positions = new double[nn];
        Map<Integer, double[]> ipps = new HashMap<>();
        double[] p = new double[3];
        for (int q = 0; q < nn; q++) {
            float[] oi = new float[nr * nc];
            byte[] om = new byte[nr * nc];
            double cn = o[ax.normalAxis()] + (mLo[ax.normalAxis()] + q) * spacing;
            for (int j = 0; j < nc; j++) {
                // 列の向きが負（−z）の軸は、添字が増えるほど座標が減る
                int mc = ax.colSign() > 0 ? mLo[ax.colAxis()] + j : mHi[ax.colAxis()] - j;
                double cc = o[ax.colAxis()] + mc * spacing;
                for (int i = 0; i < nr; i++) {
                    double cr = o[ax.rowAxis()] + (mLo[ax.rowAxis()] + i) * spacing;
                    p[ax.rowAxis()] = cr;
                    p[ax.colAxis()] = cc;
                    p[ax.normalAxis()] = cn;
                    double d0 = p[0] - o[0], d1 = p[1] - o[1], d2 = p[2] - o[2];
                    double u = (d0 * ex[0] + d1 * ex[1] + d2 * ex[2]) / dx;
                    double v = (d0 * ey[0] + d1 * ey[1] + d2 * ey[2]) / dy;
                    double kk = (d0 * en[0] + d1 * en[1] + d2 * en[2]) / dt;
                    oi[j * nr + i] = (float) trilinear(img, w, h, n, u, v, kk, true);
                    if (trilinear(msk, w, h, n, u, v, kk, false) >= maskThreshold) {
                        om[j * nr + i] = (byte) label;
                    }
                }
            }
            is.addSlice(new FloatProcessor(nr, nc, oi));
            ms.addSlice(new ByteProcessor(nr, nc, om, null));
            // 先頭画素（行 0・列 0）の患者座標
            double[] first = new double[3];
            first[ax.rowAxis()] = o[ax.rowAxis()] + mLo[ax.rowAxis()] * spacing;
            first[ax.colAxis()] = o[ax.colAxis()] + (ax.colSign() > 0 ? mLo[ax.colAxis()] : mHi[ax.colAxis()]) * spacing;
            first[ax.normalAxis()] = cn;
            ipps.put(q, first);
            positions[q] = first[0] * pn[0] + first[1] * pn[1] + first[2] * pn[2];
        }
        ImagePlus image = new ImagePlus("plane-" + plane, is);
        ImagePlus mask = new ImagePlus("plane-mask-" + plane, ms);
        Calibration oc = new Calibration();
        oc.pixelWidth = spacing;
        oc.pixelHeight = spacing;
        oc.pixelDepth = spacing;
        oc.setUnit("mm");
        image.setCalibration(oc);
        mask.setCalibration(oc.copy());
        mask.setProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED, "1");
        return new RadiomicsMapEngine.LoadedVolume(image, mask, nr, nc, nn, label, true, oc, ax.iop(), spacing, spacing,
                ipps, null, src.frameOfReferenceUid(), null, src.lossyCompressed(), src.valueCalibration(), positions,
                false, ipps.get(0).clone());
    }

    /**
     * 三線形補間。{@code clamp} なら体積の外は端の値（画像）、そうでなければ体積の外は 0（マスク）。
     * 添字は元の格子の連続座標（画素中心が整数）。
     */
    static double trilinear(float[][] vol, int w, int h, int n, double u, double v, double k, boolean clamp) {
        if (!clamp && (u < 0 || v < 0 || k < 0 || u > w - 1 || v > h - 1 || k > n - 1)) {
            return 0.0;
        }
        double uc = Math.min(Math.max(u, 0), w - 1), vc = Math.min(Math.max(v, 0), h - 1), kc = Math.min(Math.max(k, 0), n - 1);
        int i0 = (int) Math.floor(uc), j0 = (int) Math.floor(vc), k0 = (int) Math.floor(kc);
        int i1 = Math.min(i0 + 1, w - 1), j1 = Math.min(j0 + 1, h - 1), k1 = Math.min(k0 + 1, n - 1);
        double fu = uc - i0, fv = vc - j0, fk = kc - k0;
        double c00 = vol[k0][j0 * w + i0] * (1 - fu) + vol[k0][j0 * w + i1] * fu;
        double c10 = vol[k0][j1 * w + i0] * (1 - fu) + vol[k0][j1 * w + i1] * fu;
        double c01 = vol[k1][j0 * w + i0] * (1 - fu) + vol[k1][j0 * w + i1] * fu;
        double c11 = vol[k1][j1 * w + i0] * (1 - fu) + vol[k1][j1 * w + i1] * fu;
        double a = c00 * (1 - fv) + c10 * fv;
        double b = c01 * (1 - fv) + c11 * fv;
        return a * (1 - fk) + b * fk;
    }
}
