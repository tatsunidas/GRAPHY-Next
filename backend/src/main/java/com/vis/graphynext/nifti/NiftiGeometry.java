/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

/**
 * NIfTI の空間情報（sform / qform）から DICOM の幾何（IOP / IPP）を作る。
 *
 * <p>Swing 版 GRAPHY の {@code NIfTIToDicomConverter} と同じ方針:
 * <ol>
 *   <li>アフィン行列を得る（sform 優先、無ければ qform のクォータニオン、どちらも無ければ pixdim）</li>
 *   <li><b>RAS → LPS</b>（NIfTI は RAS+、DICOM は LPS）: x 行と y 行の符号を反転</li>
 *   <li>行列式が負（左手系）なら列方向（j）を反転し、原点を (rows-1) 分ずらす
 *       → 画素も上下反転して整合させる</li>
 *   <li>IOP = 行方向・列方向の単位ベクトル、IPP(k) = 原点 + k × スライス方向ベクトル</li>
 * </ol>
 *
 * <p>⚠ <b>qform_code = sform_code = 0 のファイルは患者座標を持たない</b>。その場合は
 * pixdim から軸位断を仮定した幾何を作り、{@link #synthesized} を true にする。
 * 呼び出し側はこれを結果に必ず残すこと（向きに依存する解析へ黙って流さないため）。
 */
public final class NiftiGeometry {

    /** DICOM の ImageOrientationPatient（行方向 3 ＋ 列方向 3・LPS）。 */
    public final double[] iop;
    /** 先頭スライスの原点（LPS mm）。 */
    public final double[] origin;
    /** スライス方向ベクトル（LPS mm・1 スライス分）。 */
    public final double[] sliceStep;
    /** 画素を上下反転する必要があるか（左手系の矯正）。 */
    public final boolean flipRows;
    /** 患者座標が無く、幾何を合成したか。 */
    public final boolean synthesized;
    /** 幾何の出所（"sform" / "qform" / "pixdim"）。 */
    public final String source;
    /**
     * アフィン行列のスケールが pixdim と食い違ったため、**pixdim の大きさを採用した**か。
     *
     * <p>向き（方向ベクトル）はアフィンのまま、長さだけ pixdim に合わせている。
     * true のときは呼び出し側が必ず警告として残すこと（黙って直すと、どちらが正しいか
     * 追えなくなる）。
     */
    public final boolean spacingFromPixdim;
    /** 食い違いの内容（警告文用。無ければ null）。 */
    public final String spacingNote;

    private NiftiGeometry(double[] iop, double[] origin, double[] sliceStep, boolean flipRows,
            boolean synthesized, String source, boolean spacingFromPixdim, String spacingNote) {
        this.iop = iop;
        this.origin = origin;
        this.sliceStep = sliceStep;
        this.flipRows = flipRows;
        this.synthesized = synthesized;
        this.source = source;
        this.spacingFromPixdim = spacingFromPixdim;
        this.spacingNote = spacingNote;
    }

    /** ヘッダから幾何を作る。 */
    public static NiftiGeometry of(NiftiHeader h) {
        double[][] m; // 3x4（RAS）
        String source;
        boolean synthesized;
        if (h.sformCode > 0) {
            m = new double[][] {
                { h.srowX[0], h.srowX[1], h.srowX[2], h.srowX[3] },
                { h.srowY[0], h.srowY[1], h.srowY[2], h.srowY[3] },
                { h.srowZ[0], h.srowZ[1], h.srowZ[2], h.srowZ[3] },
            };
            source = "sform";
            synthesized = false;
        } else if (h.qformCode > 0) {
            m = fromQuaternion(h);
            source = "qform";
            synthesized = false;
        } else {
            // 患者座標が無い。軸位断を仮定する（**本当の向きではない**）。
            m = new double[][] {
                { h.spacingX(), 0, 0, 0 },
                { 0, h.spacingY(), 0, 0 },
                { 0, 0, h.spacingZ(), 0 },
            };
            source = "pixdim";
            synthesized = true;
        }

        double scale = h.spatialUnitToMm();

        // ⚠ アフィンが**向きだけ**でスケールを持たないファイルが実在する
        // （EMIDEC の LGE は sform_code=2 で srow が ±1 の単位行列、実寸は pixdim 側に
        //  1.5625 / 1.5625 / 10 mm。2026-08-12 に実データで発覚）。
        // そのまま使うとスライス間隔が 1 mm になり、**容積が 10 倍狂う**。
        // 向きはアフィンを信じ、大きさが食い違うときだけ pixdim に合わせる。
        String spacingNote = null;
        boolean spacingFromPixdim = false;
        if (!synthesized) {
            double[] want = { h.spacingX(), h.spacingY(), h.spacingZ() };
            for (int col = 0; col < 3; col++) {
                double len = Math.sqrt(m[0][col] * m[0][col] + m[1][col] * m[1][col] + m[2][col] * m[2][col]);
                double target = Math.abs(want[col]);
                if (len <= 1e-9 || target <= 1e-9) {
                    continue;
                }
                // 1% を超えてずれていたら pixdim を採る（丸め誤差では起きない差）。
                if (Math.abs(len - target) / target > 0.01) {
                    double k = target / len;
                    m[0][col] *= k;
                    m[1][col] *= k;
                    m[2][col] *= k;
                    spacingFromPixdim = true;
                    String axis = col == 0 ? "行" : col == 1 ? "列" : "スライス";
                    String note = String.format("%s方向: %s=%.4f → pixdim=%.4f", axis, source, len, target);
                    spacingNote = spacingNote == null ? note : spacingNote + " / " + note;
                }
            }
        }
        // RAS → LPS（x 行と y 行を反転）＋ 単位を mm へ
        double m00 = -m[0][0] * scale;
        double m01 = -m[0][1] * scale;
        double m02 = -m[0][2] * scale;
        double m03 = -m[0][3] * scale;
        double m10 = -m[1][0] * scale;
        double m11 = -m[1][1] * scale;
        double m12 = -m[1][2] * scale;
        double m13 = -m[1][3] * scale;
        double m20 = m[2][0] * scale;
        double m21 = m[2][1] * scale;
        double m22 = m[2][2] * scale;
        double m23 = m[2][3] * scale;

        // 左手系なら列方向を反転して右手系へ（Swing 版と同じ矯正）
        double det = m00 * (m11 * m22 - m12 * m21)
                - m01 * (m10 * m22 - m12 * m20)
                + m02 * (m10 * m21 - m11 * m20);
        boolean flip = det < 0;
        if (flip) {
            int rows = h.ny();
            double o01 = m01;
            double o11 = m11;
            double o21 = m21;
            m01 = -o01;
            m11 = -o11;
            m21 = -o21;
            m03 = m03 + o01 * (rows - 1);
            m13 = m13 + o11 * (rows - 1);
            m23 = m23 + o21 * (rows - 1);
        }

        double rLen = Math.sqrt(m00 * m00 + m10 * m10 + m20 * m20);
        double cLen = Math.sqrt(m01 * m01 + m11 * m11 + m21 * m21);
        double[] iop;
        if (rLen == 0 || cLen == 0) {
            iop = new double[] { 1, 0, 0, 0, 1, 0 };
        } else {
            iop = new double[] { m00 / rLen, m10 / rLen, m20 / rLen, m01 / cLen, m11 / cLen, m21 / cLen };
        }
        return new NiftiGeometry(zeroNormalize(iop),
                zeroNormalize(new double[] { m03, m13, m23 }),
                zeroNormalize(new double[] { m02, m12, m22 }),
                flip, synthesized, source, spacingFromPixdim, spacingNote);
    }

    /**
     * −0.0 を 0.0 に潰す。符号付きゼロをそのまま DICOM の DS に書くと "-0" という値になり、
     * 文字列比較や他システムでの読み取りで無用な差異を生む。
     */
    private static double[] zeroNormalize(double[] v) {
        for (int i = 0; i < v.length; i++) {
            if (v[i] == 0.0) {
                v[i] = 0.0;
            }
        }
        return v;
    }

    /** スライス k の ImagePositionPatient。 */
    public double[] positionOf(int k) {
        return new double[] {
            origin[0] + sliceStep[0] * k,
            origin[1] + sliceStep[1] * k,
            origin[2] + sliceStep[2] * k,
        };
    }

    /** スライス間隔（スライス方向ベクトルの長さ）mm。 */
    public double sliceSpacing() {
        double len = Math.sqrt(sliceStep[0] * sliceStep[0] + sliceStep[1] * sliceStep[1] + sliceStep[2] * sliceStep[2]);
        return len > 0 ? len : 1;
    }

    /** qform（クォータニオン）→ 3x4 アフィン（RAS）。NIfTI 仕様の method 2。 */
    private static double[][] fromQuaternion(NiftiHeader h) {
        double b = h.quaternB;
        double c = h.quaternC;
        double d = h.quaternD;
        double a2 = 1.0 - (b * b + c * c + d * d);
        double a = a2 > 1e-7 ? Math.sqrt(a2) : 0.0;
        if (a2 <= 1e-7) {
            // 正規化して a=0 とする（仕様どおり）
            double norm = Math.sqrt(b * b + c * c + d * d);
            if (norm > 0) {
                b /= norm;
                c /= norm;
                d /= norm;
            }
        }
        double[][] r = new double[][] {
            { a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c) },
            { 2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b) },
            { 2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b },
        };
        double qfac = h.pixdim[0] < 0 ? -1.0 : 1.0;
        double dx = h.spacingX();
        double dy = h.spacingY();
        double dz = h.spacingZ() * qfac;
        return new double[][] {
            { r[0][0] * dx, r[0][1] * dy, r[0][2] * dz, h.qoffsetX },
            { r[1][0] * dx, r[1][1] * dy, r[1][2] * dz, h.qoffsetY },
            { r[2][0] * dx, r[2][1] * dy, r[2][2] * dz, h.qoffsetZ },
        };
    }
}
