/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

/**
 * 画像の面（スライスの向き）を、患者座標（LPS）で表す。ImageOrientationPatient（IOP）から求める。
 *
 * <ul>
 * <li>{@code name}: 法線に最も近い患者軸の面の名前（{@code AXIAL}=z・{@code SAGITTAL}=x・{@code CORONAL}=y）。
 *     {@code seriesextract.PlaneUtil.planeOf} と同じ規則（法線の絶対値が最大の軸）。</li>
 * <li>{@code tiltDeg}: 法線とその患者軸のなす角（度）。0 なら軸に揃っている。しきい値で「斜位」を決めず、角度を記録する。</li>
 * <li>位置（{@link #positionMm}）: 法線方向の位置（mm）。**法線の向きを、その患者軸の正の向きに揃える**ので、
 *     軸に揃った面は患者軸の座標そのもの（Axial=z、Sagittal=x、Coronal=y）になり、シリーズの IOP の向き（頭足・左右反転）で
 *     符号と原点が変わらない。傾いた面は、法線方向の距離（傾き 0 に向かって連続）。</li>
 * </ul>
 * ピクセル・スライス番号の計算は持たない（実座標だけ）。
 */
record ImagePlane(String name, double tiltDeg, double[] normal, int axis, double sign) {

    static final String AXIAL = "AXIAL";
    static final String SAGITTAL = "SAGITTAL";
    static final String CORONAL = "CORONAL";

    /** IOP（6 要素）から。不正（null・長さ違い・行と列が平行）なら null。 */
    static ImagePlane of(double[] iop) {
        double[] n = RadiomicsMapEngine.normalOf(iop);
        if (n == null) {
            return null;
        }
        // PlaneUtil.planeOf と同じ同値の扱い: az >= ax && az >= ay → AXIAL、次に ax >= ay → SAGITTAL、他は CORONAL
        double ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
        int axis;
        String name;
        if (az >= ax && az >= ay) {
            axis = 2;
            name = AXIAL;
        } else if (ax >= ay) {
            axis = 0;
            name = SAGITTAL;
        } else {
            axis = 1;
            name = CORONAL;
        }
        double c = Math.min(1.0, Math.abs(n[axis]));
        double sign = n[axis] < 0 ? -1.0 : 1.0;
        return new ImagePlane(name, Math.toDegrees(Math.acos(c)), n, axis, sign);
    }

    /** 点（患者座標、mm）の、この面の法線方向の位置（mm。法線を患者軸の正の向きに揃えたもの）。 */
    double positionMm(double[] point) {
        return sign * (point[0] * normal[0] + point[1] * normal[1] + point[2] * normal[2]);
    }

    /** 法線方向の位置（{@code point·normal}、向きを揃える前）から、{@link #positionMm} へ。 */
    double fromNormalPosition(double t) {
        return sign * t;
    }
}
