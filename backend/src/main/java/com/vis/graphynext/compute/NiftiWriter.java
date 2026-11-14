/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.zip.GZIPOutputStream;

/**
 * 並べ終えたボリューム（{@link VolumeAssembler.Assembled}）を NIfTI-1（{@code .nii.gz}・単一ファイル・float32）にする。
 *
 * <h3>座標</h3>
 * <p>DICOM は患者座標 LPS（x=患者の左、y=後ろ、z=頭）、NIfTI は RAS+（x=右、y=前、z=頭）。変換は
 * <b>x・y の符号を反転する 1 行列だけ</b>（{@code diag(-1,-1,1)}）で、このクラスの 1 か所に閉じ込める。
 * LPS のアフィンは {@code [ r·Δc | c·Δr | s | p0 ]}（r=IOP の先頭 3 値＝列が増える向き、c=後ろ 3 値＝行が増える向き、
 * Δc=PixelSpacing[1]、Δr=PixelSpacing[0]、s=スライス間の段差ベクトル、p0=先頭スライスの IPP）。
 *
 * <p>ガントリーチルト（スライスが法線以外の向きにもずれる）は、直交格子にできないので
 * {@code volume-sheared} で断る（sform に剪断を入れて書くと、剪断を無視するソフトで幾何が黙ってずれる）。
 *
 * <p>値は Rescale 適用後の float32（CT なら HU）。単位は NIfTI に欄が無いので {@code intent_name}（16 文字）に UCUM を入れる
 * （多くのソフトはこの欄を単位として解釈しない）。患者情報は書かない（{@code descrip} は固定文）。
 */
final class NiftiWriter {

    static final int HEADER_BYTES = 348;
    static final int VOX_OFFSET = 352;
    private static final String DESCRIP = "GRAPHY-Next export";

    private NiftiWriter() {
    }

    /**
     * 書き出した内容の注記（ログ用）。
     *
     * @param stepSource 1 枚だけのシリーズのとき、段差（スライス間隔）をどこから取ったか（SpacingBetweenSlices / SliceThickness /
     *                   default-1mm）。2 枚以上は IPP の並びから取るので null
     * @param phases     時相の数（3D は 1）
     * @param timeKey    時相を並べた鍵（TemporalPosition / AcquisitionTime / InstanceNumber）。3D は null
     * @param dtSeconds  時相の間隔（秒）。均等と確かめられなかった・AcquisitionTime が無いときは 0（推測で埋めない）
     */
    record Info(String stepSource, int phases, String timeKey, double dtSeconds) {
    }

    static Info write(OutputStream out, VolumeAssembler va, VolumeAssembler.Assembled a) throws IOException {
        if (!a.spatial() || a.normal() == null || Double.isNaN(a.dx()) || Double.isNaN(a.dy())) {
            throw new VolumeAssembler.UnsupportedLayout("nifti-no-geometry");
        }
        List<VolumeAssembler.Slice> sorted = a.sorted();
        int phases = a.phases();
        int n = sorted.size() / phases; // 1 時相あたりのスライス数。sorted は t が最も遅い（t 番目の z 番目 = t*n + z）
        double[] normal = a.normal();
        double[] p0 = sorted.get(0).ipp();
        double[] s;
        String stepSource = null;
        if (n > 1) {
            double[] pl = sorted.get(n - 1).ipp();
            s = new double[]{(pl[0] - p0[0]) / (n - 1), (pl[1] - p0[1]) / (n - 1), (pl[2] - p0[2]) / (n - 1)};
        } else {
            double step = va.sliceStepMm();
            stepSource = va.sliceStepSource();
            if (!(step > 0)) {
                step = 1.0;
                stepSource = "default-1mm";
            }
            s = new double[]{normal[0] * step, normal[1] * step, normal[2] * step};
        }
        double len = Math.sqrt(dot(s, s));
        // 🔴 段差ベクトルが法線と平行でなければチルト。各スライスが p0 + k·s の上にあることも面内を含めて確かめる。
        if (Math.abs(dot(s, normal)) / len < 1 - 1e-6) {
            throw new VolumeAssembler.UnsupportedLayout("volume-sheared");
        }
        double tol = Math.max(0.01, 0.01 * len);
        for (int idx = 0; idx < sorted.size(); idx++) {
            int k = idx % n;
            double[] p = sorted.get(idx).ipp();
            double dx = p[0] - (p0[0] + k * s[0]);
            double dy = p[1] - (p0[1] + k * s[1]);
            double dz = p[2] - (p0[2] + k * s[2]);
            if (Math.sqrt(dx * dx + dy * dy + dz * dz) > tol) {
                throw new VolumeAssembler.UnsupportedLayout("volume-sheared");
            }
        }

        double[] iop = va.iop();
        double[] r = {iop[0], iop[1], iop[2]};
        double[] c = {iop[3], iop[4], iop[5]};
        // LPS の列ベクトル（ボクセルの添字 i,j,k が 1 増えたときの移動 mm）と原点
        double[][] cols = {
                {r[0] * a.dx(), r[1] * a.dx(), r[2] * a.dx()},
                {c[0] * a.dy(), c[1] * a.dy(), c[2] * a.dy()},
                s,
                p0};
        // RAS へ: x・y の符号だけ反転
        double[][] ras = new double[4][3];
        for (int i = 0; i < 4; i++) {
            ras[i] = new double[]{-cols[i][0], -cols[i][1], cols[i][2]};
        }

        ByteBuffer h = ByteBuffer.allocate(VOX_OFFSET).order(ByteOrder.LITTLE_ENDIAN);
        h.putInt(0, HEADER_BYTES);
        h.position(40);
        short[] dim = {(short) (phases > 1 ? 4 : 3), (short) va.cols(), (short) va.rows(), (short) n, (short) phases, 1, 1, 1};
        for (short d : dim) {
            h.putShort(d);
        }
        h.putShort(70, (short) 16);   // datatype FLOAT32
        h.putShort(72, (short) 32);   // bitpix
        double dt = phases > 1 && a.dtSeconds() > 0 ? a.dtSeconds() : 0.0;
        float[] pixdim = {1f, (float) a.dx(), (float) a.dy(), (float) len, (float) dt, 0f, 0f, 0f}; // [0]=qfac(+1: 右手系)
        h.position(76);
        for (float f : pixdim) {
            h.putFloat(f);
        }
        h.putFloat(108, (float) VOX_OFFSET);
        h.putFloat(112, 1f);          // scl_slope（値は実際の量のまま）
        h.putFloat(116, 0f);          // scl_inter
        h.put(123, (byte) (dt > 0 ? 10 : 2)); // xyzt_units: mm（時間の間隔が分かるときは mm + 秒）
        double[] wc = va.windowCenter();
        double[] ww = va.windowWidth();
        float calMax = 0f;
        float calMin = 0f;
        if (wc != null && ww != null && wc.length > 0 && ww.length > 0) {
            calMax = (float) (wc[0] + ww[0] / 2);
            calMin = (float) (wc[0] - ww[0] / 2);
        }
        h.putFloat(124, calMax);
        h.putFloat(128, calMin);
        putString(h, 148, 80, DESCRIP);
        h.putShort(252, (short) 1);   // qform_code: SCANNER_ANAT
        h.putShort(254, (short) 1);   // sform_code: SCANNER_ANAT
        double[][] rot = {            // RAS の回転（列 = 正規化した軸）
                {ras[0][0] / a.dx(), ras[1][0] / a.dy(), ras[2][0] / len},
                {ras[0][1] / a.dx(), ras[1][1] / a.dy(), ras[2][1] / len},
                {ras[0][2] / a.dx(), ras[1][2] / a.dy(), ras[2][2] / len}};
        double[] q = quaternion(rot);
        h.putFloat(256, (float) q[0]);
        h.putFloat(260, (float) q[1]);
        h.putFloat(264, (float) q[2]);
        h.putFloat(268, (float) ras[3][0]);
        h.putFloat(272, (float) ras[3][1]);
        h.putFloat(276, (float) ras[3][2]);
        for (int row = 0; row < 3; row++) {          // srow_x, srow_y, srow_z
            for (int col = 0; col < 4; col++) {
                h.putFloat(280 + row * 16 + col * 4, (float) ras[col][row]);
            }
        }
        String unit = va.valueUnit();
        if (unit != null && !unit.isBlank() && unit.length() <= 15 && unit.chars().allMatch(ch -> ch < 128)) {
            putString(h, 328, 16, unit);
        }
        putString(h, 344, 4, "n+1");

        GZIPOutputStream gz = new GZIPOutputStream(out);
        gz.write(h.array());          // 348 バイトのヘッダ＋拡張なしの 4 バイト（0）
        ByteBuffer buf = ByteBuffer.allocate(va.rows() * va.cols() * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (VolumeAssembler.Slice sl : sorted) {
            buf.clear();
            va.putFloats(sl, buf);
            gz.write(buf.array(), 0, buf.position());
        }
        gz.finish();
        return new Info(stepSource, phases, a.timeKey(), dt);
    }

    /** 回転行列（det=+1）→ NIfTI の quaternion（b, c, d。a は 1 から作られる）。 */
    static double[] quaternion(double[][] r) {
        double a = r[0][0] + r[1][1] + r[2][2] + 1.0;
        double b;
        double c;
        double d;
        if (a > 0.5) {
            a = 0.5 * Math.sqrt(a);
            b = 0.25 * (r[2][1] - r[1][2]) / a;
            c = 0.25 * (r[0][2] - r[2][0]) / a;
            d = 0.25 * (r[1][0] - r[0][1]) / a;
        } else {
            double xd = 1.0 + r[0][0] - (r[1][1] + r[2][2]);
            double yd = 1.0 + r[1][1] - (r[0][0] + r[2][2]);
            double zd = 1.0 + r[2][2] - (r[0][0] + r[1][1]);
            if (xd > 1.0) {
                b = 0.5 * Math.sqrt(xd);
                c = 0.25 * (r[0][1] + r[1][0]) / b;
                d = 0.25 * (r[0][2] + r[2][0]) / b;
                a = 0.25 * (r[2][1] - r[1][2]) / b;
            } else if (yd > 1.0) {
                c = 0.5 * Math.sqrt(yd);
                b = 0.25 * (r[0][1] + r[1][0]) / c;
                d = 0.25 * (r[1][2] + r[2][1]) / c;
                a = 0.25 * (r[0][2] - r[2][0]) / c;
            } else {
                d = 0.5 * Math.sqrt(zd);
                b = 0.25 * (r[0][2] + r[2][0]) / d;
                c = 0.25 * (r[1][2] + r[2][1]) / d;
                a = 0.25 * (r[1][0] - r[0][1]) / d;
            }
            if (a < 0.0) {
                b = -b;
                c = -c;
                d = -d;
            }
        }
        return new double[]{b, c, d};
    }

    private static void putString(ByteBuffer h, int offset, int max, String text) {
        byte[] b = text.getBytes(StandardCharsets.US_ASCII);
        for (int i = 0; i < Math.min(b.length, max); i++) {
            h.put(offset + i, b[i]);
        }
    }

    private static double dot(double[] a, double[] b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }
}
