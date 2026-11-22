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
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.function.ToDoubleFunction;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 患者座標の軸に揃った断面への再スライス。基準は、元の体積に**線形な場** f(P) = 3x + 5y − 2z + 7 を載せたときの解析値
 * （三線形補間は線形な場を厳密に再現するので、断面の各画素の値は、その画素の患者座標での f の値）。本体の補間は使わない。
 */
class LpsResamplerTest {

    private static double f(double[] p) {
        return 3 * p[0] + 5 * p[1] - 2 * p[2] + 7;
    }

    /** 元の体積: 画素 (i,j,k) の中心 = O + i·dx·ex + j·dy·ey + k·dz·n。値は f（患者座標）。ROI は世界座標の箱の中の画素。 */
    private static RadiomicsMapEngine.LoadedVolume source(int w, int h, int n, double dx, double dy, double dz, double[] iop,
                                                          double[] origin, double[] boxLo, double[] boxHi) {
        double[] ex = {iop[0], iop[1], iop[2]};
        double[] ey = {iop[3], iop[4], iop[5]};
        double[] en = RadiomicsMapEngine.normalOf(iop);
        ImageStack is = new ImageStack(w, h);
        ImageStack ms = new ImageStack(w, h);
        double[] pos = new double[n];
        Map<Integer, double[]> ipps = new HashMap<>();
        for (int k = 0; k < n; k++) {
            float[] px = new float[w * h];
            byte[] mp = new byte[w * h];
            for (int j = 0; j < h; j++) {
                for (int i = 0; i < w; i++) {
                    double[] p = new double[3];
                    for (int a = 0; a < 3; a++) {
                        p[a] = origin[a] + i * dx * ex[a] + j * dy * ey[a] + k * dz * en[a];
                    }
                    px[j * w + i] = (float) f(p);
                    boolean in = true;
                    for (int a = 0; a < 3; a++) {
                        in &= p[a] >= boxLo[a] && p[a] <= boxHi[a];
                    }
                    mp[j * w + i] = (byte) (in ? 1 : 0);
                }
            }
            is.addSlice(new FloatProcessor(w, h, px));
            ms.addSlice(new ByteProcessor(w, h, mp, null));
            double[] ipp = {origin[0] + k * dz * en[0], origin[1] + k * dz * en[1], origin[2] + k * dz * en[2]};
            ipps.put(k, ipp);
            pos[k] = ipp[0] * en[0] + ipp[1] * en[1] + ipp[2] * en[2];
        }
        ImagePlus img = new ImagePlus("i", is);
        ImagePlus msk = new ImagePlus("m", ms);
        Calibration cal = new Calibration();
        cal.pixelWidth = dx;
        cal.pixelHeight = dy;
        cal.pixelDepth = dz;
        cal.setUnit("mm");
        img.setCalibration(cal);
        msk.setCalibration(cal.copy());
        msk.setProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED, "1");
        return new RadiomicsMapEngine.LoadedVolume(img, msk, w, h, n, 1, true, cal, iop, dy, dx, ipps, new String[n], "1.2",
                null, false, ValueCalibration.UNSET, pos, false, origin);
    }

    /** 再スライスした体積の、画素 (i,j) のスライス q の患者座標（体積が持つ先頭画素の座標と向きから）。 */
    private static double[] worldOf(RadiomicsMapEngine.LoadedVolume v, int i, int j, int q) {
        double s = v.calibration().pixelWidth;
        double[] iop = v.imageOrientationPatient();
        double[] ipp = v.ippByZ().get(q);
        return new double[] {
                ipp[0] + i * s * iop[0] + j * s * iop[3], ipp[1] + i * s * iop[1] + j * s * iop[4], ipp[2] + i * s * iop[2] + j * s * iop[5]};
    }

    private static final double[] AXIAL = {1, 0, 0, 0, 1, 0};

    @Test
    void everyPixelOfEveryPlaneHasTheFieldValueAtItsPatientCoordinate() {
        // 軸位で取得した体積（間隔 1・1・2 mm）を、3 つの断面へ 0.5 mm 間隔で
        RadiomicsMapEngine.LoadedVolume src = source(30, 30, 12, 1, 1, 2, AXIAL, new double[] {-5, 10, 100}, new double[] {2, 12, 102}, new double[] {20, 30, 118});
        for (String plane : new String[] {ImagePlane.AXIAL, ImagePlane.SAGITTAL, ImagePlane.CORONAL}) {
            RadiomicsMapEngine.LoadedVolume v = LpsResampler.reslice(src, 1, plane, 0.5, 0.5);
            assertEquals(plane, ImagePlane.of(v.imageOrientationPatient()).name());
            assertEquals(0.0, ImagePlane.of(v.imageOrientationPatient()).tiltDeg(), 1e-9);
            int checked = 0;
            for (int q = 0; q < v.slices(); q++) {
                float[] px = (float[]) v.image().getStack().getProcessor(q + 1).getPixels();
                for (int j = 0; j < v.height(); j++) {
                    for (int i = 0; i < v.width(); i++) {
                        double[] p = worldOf(v, i, j, q);
                        boolean inside = p[0] >= -5 && p[0] <= 24 && p[1] >= 10 && p[1] <= 39 && p[2] >= 100 && p[2] <= 122;
                        if (inside) {
                            assertEquals(f(p), px[j * v.width() + i], 2e-3, plane + " (" + i + "," + j + "," + q + ")");
                            checked++;
                        }
                    }
                }
            }
            assertTrue(checked > 1000, plane + ": 検査した画素 " + checked);
        }
    }

    @Test
    void thePositionsAreThePatientAxisCoordinateInAscendingOrder() {
        RadiomicsMapEngine.LoadedVolume src = source(30, 30, 12, 1, 1, 2, AXIAL, new double[] {-5, 10, 100}, new double[] {2, 12, 102}, new double[] {20, 30, 118});
        double[][] want = {
                // 平面, 法線の患者軸（0=x,1=y,2=z）, ROI の範囲（軸の座標）
                {0, 2, 102, 118}, {1, 0, 2, 20}, {2, 1, 12, 30}};
        String[] planes = {ImagePlane.AXIAL, ImagePlane.SAGITTAL, ImagePlane.CORONAL};
        for (int pi = 0; pi < 3; pi++) {
            RadiomicsMapEngine.LoadedVolume v = LpsResampler.reslice(src, 1, planes[pi], 0.5, 0.5);
            double[] pos = MaxSectionService.positionsMm(v);
            int axis = (int) want[pi][1];
            for (int q = 0; q < pos.length; q++) {
                double[] p = worldOf(v, 0, 0, q);
                assertEquals(p[axis], pos[q], 1e-9, planes[pi] + ": 位置は患者軸の座標");
                if (q > 0) {
                    assertTrue(pos[q] > pos[q - 1], planes[pi] + ": 昇順");
                }
            }
            // ROI の範囲（+1 画素の余白）を覆う
            assertTrue(pos[0] <= want[pi][2] + 1e-9 && pos[pos.length - 1] >= want[pi][3] - 1e-9, planes[pi] + ": ROI を覆う " + pos[0] + ".." + pos[pos.length - 1]);
        }
    }

    @Test
    void withTheSameAxisAndSpacingTheSourceSlicesComeBackUnchanged() {
        // 軸位 1×1×1 mm の体積を、Axial へ 1 mm（格子点が画素中心に一致）→ 元のスライスの値と同じ
        RadiomicsMapEngine.LoadedVolume src = source(20, 20, 10, 1, 1, 1, AXIAL, new double[] {0, 0, 0}, new double[] {4, 4, 3}, new double[] {15, 15, 7});
        RadiomicsMapEngine.LoadedVolume v = LpsResampler.reslice(src, 1, ImagePlane.AXIAL, 1.0, 0.5);
        double[] pos = MaxSectionService.positionsMm(v);
        for (int q = 0; q < pos.length; q++) {
            int k = (int) Math.round(pos[q]); // 元のスライス番号（間隔 1、原点 z=0）
            float[] want = (float[]) src.image().getStack().getProcessor(k + 1).getPixels();
            float[] got = (float[]) v.image().getStack().getProcessor(q + 1).getPixels();
            // 出力の (i,j) の世界座標 → 元の画素
            for (int j = 0; j < v.height(); j++) {
                for (int i = 0; i < v.width(); i++) {
                    double[] p = worldOf(v, i, j, q);
                    int si = (int) Math.round(p[0]), sj = (int) Math.round(p[1]);
                    if (si >= 0 && sj >= 0 && si < 20 && sj < 20) {
                        assertEquals(want[sj * 20 + si], got[j * v.width() + i], 0f, "恒等: 補間をしない");
                    }
                }
            }
        }
    }

    @Test
    void anObliqueAcquisitionIsResampledToThePatientAxes() {
        // 軸位を z 軸まわりに 20° 回した取得面（行 (cos,sin,0)・列 (−sin,cos,0)）から、Axial へ 1 mm
        double a = Math.toRadians(20);
        double[] iop = {Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0};
        RadiomicsMapEngine.LoadedVolume src = source(40, 40, 10, 1, 1, 1, iop, new double[] {0, 0, 0}, new double[] {-100, -100, 3}, new double[] {100, 100, 7});
        RadiomicsMapEngine.LoadedVolume v = LpsResampler.reslice(src, 1, ImagePlane.AXIAL, 1.0, 0.5);
        int checked = 0;
        for (int q = 0; q < v.slices(); q++) {
            float[] px = (float[]) v.image().getStack().getProcessor(q + 1).getPixels();
            for (int j = 0; j < v.height(); j++) {
                for (int i = 0; i < v.width(); i++) {
                    double[] p = worldOf(v, i, j, q);
                    // 元の体積の内側（回した格子の中）だけを検査する（外は端の値）
                    double u = p[0] * Math.cos(a) + p[1] * Math.sin(a), vv = -p[0] * Math.sin(a) + p[1] * Math.cos(a);
                    if (u >= 1 && u <= 38 && vv >= 1 && vv <= 38) {
                        assertEquals(f(p), px[j * v.width() + i], 2e-3);
                        checked++;
                    }
                }
            }
        }
        assertTrue(checked > 500, "検査した画素 " + checked);
    }

    @Test
    void theMaskIsTheTrilinearIndicatorAtTheThresholdCountedIndependently() {
        // 箱の ROI（元の格子の画素中心が箱の中）。三線形補間した 0/1 が 0.5 以上の格子点の数を、テストの中で別に数える
        double[] lo = {10.25, 10.25, 5.25}, hi = {20.25, 20.25, 9.25};
        RadiomicsMapEngine.LoadedVolume src = source(32, 32, 16, 1, 1, 1, AXIAL, new double[] {0, 0, 0}, lo, hi);
        double s = 0.4;
        RadiomicsMapEngine.LoadedVolume v = LpsResampler.reslice(src, 1, ImagePlane.CORONAL, s, 0.5);
        long got = 0;
        for (int q = 0; q < v.slices(); q++) {
            byte[] mp = (byte[]) v.mask().getStack().getProcessor(q + 1).getPixels();
            for (byte b : mp) {
                got += b != 0 ? 1 : 0;
            }
        }
        // 独立の数え方: 各軸の 1 次元の指示関数（画素中心の整数が箱の中なら 1）を線形補間した値の積が 0.5 以上の格子点
        ToDoubleFunction<double[]> weight = x -> {
            double prod = 1;
            double[] l = lo, h = hi;
            for (int a = 0; a < 3; a++) {
                int c0 = (int) Math.floor(x[a]);
                double f0 = (c0 >= l[a] && c0 <= h[a]) ? 1 : 0, f1 = (c0 + 1 >= l[a] && c0 + 1 <= h[a]) ? 1 : 0;
                prod *= f0 * (1 - (x[a] - c0)) + f1 * (x[a] - c0);
            }
            return prod;
        };
        long want = 0;
        for (int q = 0; q < v.slices(); q++) {
            for (int j = 0; j < v.height(); j++) {
                for (int i = 0; i < v.width(); i++) {
                    double[] p = worldOf(v, i, j, q);
                    if (p[0] >= 0 && p[0] <= 31 && p[1] >= 0 && p[1] <= 31 && p[2] >= 0 && p[2] <= 15 && weight.applyAsDouble(p) >= 0.5) {
                        want++;
                    }
                }
            }
        }
        assertTrue(want > 500, "数えた画素 " + want);
        assertEquals(want, got, "ROI の画素数は、独立に数えた値と一致");
    }

    @Test
    void refusesWithAReasonWhatItCannotDo() {
        RadiomicsMapEngine.LoadedVolume ok = source(10, 10, 6, 1, 1, 1, AXIAL, new double[] {0, 0, 0}, new double[] {2, 2, 1}, new double[] {6, 6, 4});
        // 位置・原点が無い
        RadiomicsMapEngine.LoadedVolume noOrigin = new RadiomicsMapEngine.LoadedVolume(ok.image(), ok.mask(), 10, 10, 6, 1, true,
                ok.calibration(), AXIAL, 1, 1, ok.ippByZ(), ok.sopPerZ(), "1.2", null, false, ValueCalibration.UNSET);
        assertTrue(assertThrows(IllegalArgumentException.class, () -> LpsResampler.reslice(noOrigin, 1, ImagePlane.AXIAL, 1, 0.5)).getMessage().contains("位置"));
        // 1 枚だけ
        RadiomicsMapEngine.LoadedVolume one = source(10, 10, 1, 1, 1, 1, AXIAL, new double[] {0, 0, 0}, new double[] {2, 2, -1}, new double[] {6, 6, 1});
        assertTrue(assertThrows(IllegalArgumentException.class, () -> LpsResampler.reslice(one, 1, ImagePlane.CORONAL, 1, 0.5)).getMessage().contains("1 枚"));
        // ROI が空
        RadiomicsMapEngine.LoadedVolume empty = source(10, 10, 6, 1, 1, 1, AXIAL, new double[] {0, 0, 0}, new double[] {100, 100, 100}, new double[] {101, 101, 101});
        assertTrue(assertThrows(IllegalArgumentException.class, () -> LpsResampler.reslice(empty, 1, ImagePlane.AXIAL, 1, 0.5)).getMessage().contains("ROI が空"));
        // 間隔が不正・不明な断面
        assertThrows(IllegalArgumentException.class, () -> LpsResampler.reslice(ok, 1, ImagePlane.AXIAL, 0, 0.5));
        assertThrows(IllegalArgumentException.class, () -> LpsResampler.reslice(ok, 1, "OBLIQUE", 1, 0.5));
        // 大きすぎる
        assertTrue(assertThrows(IllegalArgumentException.class, () -> LpsResampler.reslice(ok, 1, ImagePlane.AXIAL, 1e-4, 0.5)).getMessage().contains("大きすぎ"));
    }

    @Test
    void anUnevenSliceSpacingIsRefused() {
        RadiomicsMapEngine.LoadedVolume ok = source(10, 10, 6, 1, 1, 1, AXIAL, new double[] {0, 0, 0}, new double[] {2, 2, 1}, new double[] {6, 6, 4});
        double[] pos = {0, 1, 2, 4, 5, 6}; // 不等間隔
        RadiomicsMapEngine.LoadedVolume uneven = new RadiomicsMapEngine.LoadedVolume(ok.image(), ok.mask(), 10, 10, 6, 1, true,
                ok.calibration(), AXIAL, 1, 1, ok.ippByZ(), ok.sopPerZ(), "1.2", null, false, ValueCalibration.UNSET, pos, false,
                new double[] {0, 0, 0});
        assertTrue(assertThrows(IllegalArgumentException.class, () -> LpsResampler.reslice(uneven, 1, ImagePlane.AXIAL, 1, 0.5)).getMessage().contains("等間隔"));
        assertArrayEquals(new double[] {0, 1, 2, 4, 5, 6}, uneven.normalPositionsMm());
    }
}
