/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * スライスの並び（位置・間隔・チルト）の判定。純粋 Java（DICOM にも ImageJ にも触れない）。
 *
 * <p>本体のビューア（{@code frontend/src/viewer/sliceGeometry.ts}、{@code fw/slice-depth-policy.md}）と同じ規則:
 * スライスの位置は IPP を ImageOrientationPatient の法線へ射影した値。間隔の分類の許容は
 * {@code max(0.01 mm, 公称間隔の 1%)}（0.01 mm は IPP の DS 値の丸め、1% は 1 ボクセルの 1/100）。
 * 欠損は「すべての間隔が最小間隔の整数倍（誤差 10% 以内）」。
 *
 * <p>以前は先頭 2 枚の距離をシリーズ全体の間隔として使っていたため、不等間隔・欠損のシリーズで代表にならない値になり、
 * 警告も出なかった。
 */
final class SliceLayout {

    enum Kind {
        /** 間隔が一様。 */
        UNIFORM,
        /** 一様でなく、すべての間隔が最小間隔の整数倍（欠けたスライスがある）。 */
        MISSING,
        /** 間隔が不規則。 */
        IRREGULAR,
        /** 同じ位置に複数のスライスがある。 */
        DUPLICATES,
        /** スライスが 1 枚だけ。 */
        SINGLE,
        /** IPP または IOP が足りず、位置が決まらない。 */
        UNKNOWN
    }

    /** チルトありとみなす角度（度）。IPP の進む向きと法線のなす角。ビューア（gantryTiltCorrect）の判定に合わせる。 */
    static final double TILT_THRESHOLD_DEG = 0.5;

    private final Kind kind;
    private final double[] positionsByIndex;
    private final double nominalSpacing;
    private final double minGap;
    private final double maxGap;
    private final int missingCount;
    private final double tiltDeg;

    private SliceLayout(Kind kind, double[] positionsByIndex, double nominalSpacing, double minGap, double maxGap,
                        int missingCount, double tiltDeg) {
        this.kind = kind;
        this.positionsByIndex = positionsByIndex;
        this.nominalSpacing = nominalSpacing;
        this.minGap = minGap;
        this.maxGap = maxGap;
        this.missingCount = missingCount;
        this.tiltDeg = tiltDeg;
    }

    Kind kind() { return kind; }

    /** スライス index → 法線方向の位置 [mm]（IPP が無ければ NaN）。 */
    double[] positionsByIndex() { return positionsByIndex; }

    /** 一様なら平均間隔、そうでなければ最小間隔 [mm]。求まらなければ 0。 */
    double nominalSpacing() { return nominalSpacing; }

    double minGap() { return minGap; }

    double maxGap() { return maxGap; }

    /**
     * スライス index の局所間隔 [mm] = 隣り合うスライスとの間隔の大きい方（端は片側だけ）。位置が決まらなければ 0。
     * マスクの z 整列の許容（その局所間隔の半分）に使う。全体の最大間隔を使うと、間隔の狭い所でも許容が広がり、
     * マスクの端の外側のスライスまで拾ってしまう。
     */
    double localGap(int index) {
        double p = positionsByIndex[index];
        if (Double.isNaN(p)) return 0;
        double below = Double.NaN, above = Double.NaN;
        for (double q : positionsByIndex) {
            if (Double.isNaN(q) || q == p) continue;
            if (q < p && (Double.isNaN(below) || q > below)) below = q;
            if (q > p && (Double.isNaN(above) || q < above)) above = q;
        }
        double a = Double.isNaN(below) ? 0 : p - below, b = Double.isNaN(above) ? 0 : above - p;
        return Math.max(a, b);
    }

    /** 欠けたスライスの枚数（{@link Kind#MISSING} のとき。他は 0）。 */
    int missingCount() { return missingCount; }

    /** IPP の進む向きと法線のなす角 [度]（スライスが 2 枚未満・求まらなければ 0）。 */
    double tiltDeg() { return tiltDeg; }

    boolean hasTilt() { return tiltDeg > TILT_THRESHOLD_DEG; }

    /** 直交・等間隔の格子としてそのまま扱えるか（間隔が一様で、チルトが無い）。 */
    boolean isRegularGrid() {
        return (kind == Kind.UNIFORM || kind == Kind.SINGLE) && !hasTilt();
    }

    /**
     * @param ipps スライス index 順の IPP（無いスライスは null）
     * @param iop  ImageOrientationPatient（6 要素。null・不正なら位置が決まらず UNKNOWN）
     */
    static SliceLayout of(List<double[]> ipps, double[] iop) {
        int n = ipps.size();
        double[] normal = normalOf(iop);
        double[] pos = new double[n];
        Arrays.fill(pos, Double.NaN);
        boolean all = normal != null && n > 0;
        for (int i = 0; i < n; i++) {
            double[] p = ipps.get(i);
            if (p == null || p.length != 3 || normal == null) {
                all = false;
                continue;
            }
            pos[i] = p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2];
        }
        if (!all) return new SliceLayout(Kind.UNKNOWN, pos, 0, 0, 0, 0, 0);
        if (n == 1) return new SliceLayout(Kind.SINGLE, pos, 0, 0, 0, 0, 0);

        Integer[] order = new Integer[n];
        for (int i = 0; i < n; i++) order[i] = i;
        Arrays.sort(order, (a, b) -> Double.compare(pos[a], pos[b]));
        List<Double> gaps = new ArrayList<>();
        for (int i = 1; i < n; i++) gaps.add(pos[order[i]] - pos[order[i - 1]]);
        double min = Double.MAX_VALUE, max = 0, sum = 0;
        for (double g : gaps) {
            min = Math.min(min, g);
            max = Math.max(max, g);
            sum += g;
        }
        double mean = sum / gaps.size();
        double tilt = tiltOf(ipps, order, normal);
        if (min <= 0.01) return new SliceLayout(Kind.DUPLICATES, pos, 0, min, max, 0, tilt);
        double tol = Math.max(0.01, 0.01 * mean);
        if (max - min <= tol) return new SliceLayout(Kind.UNIFORM, pos, mean, min, max, 0, tilt);
        int missing = 0;
        boolean multiples = true;
        for (double g : gaps) {
            double r = g / min;
            long k = Math.round(r);
            if (k < 1 || Math.abs(r - k) > 0.1 * k) {
                multiples = false;
                break;
            }
            missing += (int) (k - 1);
        }
        return multiples
                ? new SliceLayout(Kind.MISSING, pos, min, min, max, missing, tilt)
                : new SliceLayout(Kind.IRREGULAR, pos, min, min, max, 0, tilt);
    }

    /** IPP の進む向き（法線位置の最小のスライス → 最大のスライス）と法線のなす角 [度]。 */
    private static double tiltOf(List<double[]> ipps, Integer[] order, double[] normal) {
        double[] a = ipps.get(order[0]), b = ipps.get(order[order.length - 1]);
        double dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        double len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) return 0;
        double c = Math.abs(dx * normal[0] + dy * normal[1] + dz * normal[2]) / len;
        return Math.toDegrees(Math.acos(Math.min(1.0, c)));
    }

    /** 単位法線 = 行方向 × 列方向。IOP が不正なら null。 */
    static double[] normalOf(double[] iop) {
        if (iop == null || iop.length < 6) return null;
        double[] n = {
                iop[1] * iop[5] - iop[2] * iop[4],
                iop[2] * iop[3] - iop[0] * iop[5],
                iop[0] * iop[4] - iop[1] * iop[3]};
        double len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        if (len < 1e-9) return null;
        return new double[]{n[0] / len, n[1] / len, n[2] / len};
    }

    /** 利用者に出す、格子として扱えない理由（{@link #isRegularGrid()} が false のとき）。 */
    String irregularityMessage() {
        StringBuilder sb = new StringBuilder();
        switch (kind) {
            case MISSING -> sb.append(String.format("スライスが %d 枚欠けています（間隔 %.3f〜%.3f mm）", missingCount, minGap, maxGap));
            case IRREGULAR -> sb.append(String.format("スライス間隔が不規則です（%.3f〜%.3f mm）", minGap, maxGap));
            case DUPLICATES -> sb.append("同じ位置に複数のスライスがあります");
            default -> { }
        }
        if (hasTilt()) {
            if (sb.length() > 0) sb.append("。また");
            sb.append(String.format("ガントリーチルト（%.1f°）があります", tiltDeg));
        }
        sb.append("。この解析はスライスが直交・等間隔の格子に並んでいることを前提にします。"
                + "間隔を揃えた（チルトを補正した）シリーズを作ってから計算してください。");
        return sb.toString();
    }
}
