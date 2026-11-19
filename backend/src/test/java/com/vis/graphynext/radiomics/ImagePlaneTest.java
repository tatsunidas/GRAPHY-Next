/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.seriesextract.PlaneUtil;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/** 画像の面（IOP から求める面の名前・傾き角・固定の患者軸の向きの位置）。 */
class ImagePlaneTest {

    private static final double TOL = 1e-9;

    @Test
    void axialSagittalAndCoronalSeriesGetTheirPatientAxisCoordinate() {
        // 軸位（頭向き）: 法線 +z。位置は z
        ImagePlane axial = ImagePlane.of(new double[] {1, 0, 0, 0, 1, 0});
        assertEquals(ImagePlane.AXIAL, axial.name());
        assertEquals(0.0, axial.tiltDeg(), TOL);
        assertEquals(12.5, axial.positionMm(new double[] {7, -3, 12.5}), TOL);
        // 軸位（足向き。行 (1,0,0)、列 (0,-1,0)）: 法線 -z でも、位置は z そのもの（向きで符号が変わらない）
        ImagePlane feetFirst = ImagePlane.of(new double[] {1, 0, 0, 0, -1, 0});
        assertEquals(ImagePlane.AXIAL, feetFirst.name());
        assertEquals(12.5, feetFirst.positionMm(new double[] {7, -3, 12.5}), TOL);
        // 矢状: IOP (0,1,0, 0,0,-1) の法線は -x。位置は x（符号は IOP の法線向きに依らない）
        ImagePlane sagittal = ImagePlane.of(new double[] {0, 1, 0, 0, 0, -1});
        assertEquals(ImagePlane.SAGITTAL, sagittal.name());
        assertEquals(0.0, sagittal.tiltDeg(), TOL);
        assertEquals(-33.0, sagittal.positionMm(new double[] {-33, 4, 5}), TOL);
        // 冠状: IOP (1,0,0, 0,0,-1) の法線は +y。位置は y
        ImagePlane coronal = ImagePlane.of(new double[] {1, 0, 0, 0, 0, -1});
        assertEquals(ImagePlane.CORONAL, coronal.name());
        assertEquals(4.0, coronal.positionMm(new double[] {-33, 4, 5}), TOL);
    }

    @Test
    void aTiltedPlaneKeepsItsNearestAxisAndRecordsTheAngle() {
        double a = Math.toRadians(20);
        // x 軸まわりに 20°傾けた軸位: 行 (1,0,0)、列 (0,cos,sin) → 法線 (0,-sin,cos)
        ImagePlane p = ImagePlane.of(new double[] {1, 0, 0, 0, Math.cos(a), Math.sin(a)});
        assertEquals(ImagePlane.AXIAL, p.name());
        assertEquals(20.0, p.tiltDeg(), 1e-9);
        // 位置は法線方向の距離（軸の座標ではない）: 点 (0,10,30) の法線位置 = -10 sin20 + 30 cos20
        assertEquals(-10 * Math.sin(a) + 30 * Math.cos(a), p.positionMm(new double[] {0, 10, 30}), 1e-9);
        // 傾き 0 に向かって連続（しきい値で別の規則に切り替わらない）
        ImagePlane almost = ImagePlane.of(new double[] {1, 0, 0, 0, Math.cos(1e-6), Math.sin(1e-6)});
        assertEquals(30.0, almost.positionMm(new double[] {0, 10, 30}), 1e-4);
    }

    @Test
    void aMirroredAxisKeepsThePositiveSense() {
        // 法線が -z の傾いた軸位でも、位置は +z を向く法線方向の距離（符号を揃える）
        double a = Math.toRadians(15);
        double[] iop = {1, 0, 0, 0, -Math.cos(a), Math.sin(a)}; // 行 (1,0,0)、列 (0,-cos,sin) → 法線 (0,-sin,-cos)
        ImagePlane p = ImagePlane.of(iop);
        assertEquals(ImagePlane.AXIAL, p.name());
        assertEquals(-1.0, p.sign(), 0, "法線は -z 側");
        assertEquals(Math.cos(a), p.sign() * p.normal()[2], 1e-12, "向きを揃えた法線は +z 側（z 成分は cos 15°）");
        assertEquals(15.0, p.tiltDeg(), 1e-9);
    }

    @Test
    void theNameMatchesPlaneUtilForManyOrientations() {
        Random rnd = new Random(42);
        for (int i = 0; i < 500; i++) {
            // 直交する単位ベクトル 2 本をランダムに作る
            double[] r = unit(rnd);
            double[] t = unit(rnd);
            double d = r[0] * t[0] + r[1] * t[1] + r[2] * t[2];
            double[] c = {t[0] - d * r[0], t[1] - d * r[1], t[2] - d * r[2]};
            double len = Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
            if (len < 1e-3) {
                continue;
            }
            c = new double[] {c[0] / len, c[1] / len, c[2] / len};
            double[] iop = {r[0], r[1], r[2], c[0], c[1], c[2]};
            Attributes h = new Attributes();
            h.setDouble(Tag.ImageOrientationPatient, VR.DS, iop);
            assertEquals(PlaneUtil.planeOf(h), ImagePlane.of(iop).name(), "規則は PlaneUtil と同じ");
            ImagePlane p = ImagePlane.of(iop);
            // 傾き角は、法線とその軸のなす角（0〜54.7°。最大成分は 1/√3 以上）
            assertEquals(Math.toDegrees(Math.acos(Math.abs(p.normal()[p.axis()]))), p.tiltDeg(), 1e-9);
            assertEquals(true, p.tiltDeg() <= 54.7357 + 1e-6);
        }
    }

    @Test
    void invalidOrientationsGiveNull() {
        assertNull(ImagePlane.of(null));
        assertNull(ImagePlane.of(new double[] {1, 0, 0}));
        assertNull(ImagePlane.of(new double[] {1, 0, 0, 1, 0, 0}), "行と列が平行なら法線が無い");
    }

    private static double[] unit(Random rnd) {
        double[] v = {rnd.nextGaussian(), rnd.nextGaussian(), rnd.nextGaussian()};
        double len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return new double[] {v[0] / len, v[1] / len, v[2] / len};
    }
}
