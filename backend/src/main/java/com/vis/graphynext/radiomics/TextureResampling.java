/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.ImageProcessor;
import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import io.github.tatsunidas.radiomics.main.Utils;

import java.util.Map;

/**
 * 計算前のリサンプリング（環境設定 ▸ テクスチャ ▸ リサンプリング）。
 *
 * <p><b>なぜ要るか</b>: 特徴量の多くは距離をボクセル格子で測る。臨床 CT は面内 0.6mm・
 * スライス 5mm といった非等方が普通なので、そのまま計算すると「隣」の意味が方向で 8 倍違う。
 * GLAM は距離ごとの構造そのものを見る族なので、とりわけ効く（RadiomicsJ も非等方だと警告する）。
 * IBSI も特徴抽出の前に等方格子へ補間することを求めている（IBSI 5.2）。
 *
 * <p><b>方針</b>: 補間そのものは <b>RadiomicsJ の {@code Utils.resample3D} に任せる</b>
 * （IBSI 5.2.1 の格子中心合わせ・マスクの部分体積しきい値がすでに入っている）。
 * ここが持つのはその前後 — 設定の解釈と、<b>低解像度側で得たマップを元の格子へ戻す逆変換</b>。
 *
 * <p><b>可視化マップの幾何は変えない</b>。計算はリサンプリング格子で行うが、出来上がった
 * マップは元シリーズと同じ格子へ戻してから DICOM 化する。派生シリーズの IPP/PixelSpacing/
 * Rows×Cols が元と一致していることは、Fusion で重ねられる前提であり、ここを崩さない
 * （幾何が一致することは実機検証で確認済み — {@code fw/texture-radiomics-design.md} §11.10）。
 */
final class TextureResampling {

    /**
     * 目標間隔の既定（mm）。
     *
     * <p>⚠ <b>設定は「触った項目しか保存されない」</b>。チェックだけ入れて X/Y/Z を触らなければ
     * バックエンドには {@code Resampling_BOOL} しか届かない。UI 側の既定値
     * （{@code frontend/src/settings/registry.ts} の {@code texture.Resampling[XYZ]_DOUBLE}）と
     * <b>同じ値をここにも置く</b>。ずれると「画面には 1 と出ているのに別の間隔で計算される」になる。
     */
    static final double DEFAULT_SPACING_MM = 1.0;

    /** 目標間隔がこれより細かいと、格子が現実的でない大きさになるので断る。 */
    private static final double MIN_SPACING_MM = 0.05;

    /** リサンプリングでボクセル数がこの倍率を超えたら断る（黙って何十分も待たせないため）。 */
    private static final double MAX_VOXEL_GROWTH = 10.0;

    private TextureResampling() {}

    /**
     * リサンプリング後の格子と、そこから元の格子へ戻すための係数。
     *
     * <p>{@code Utils.trilinearInterpolation} の順変換は
     * {@code x_src = origin + i_new / scale}（{@code scale = 元 spacing / 目標 spacing}、
     * {@code origin = Utils.gridOrigin(n, newN, scale)}）。ここが持つのはその逆
     * {@code i_new = (x_src - origin) * scale} で、原点は<b>同じ関数から取る</b>ので
     * ライブラリ側が格子合わせを変えれば自動的に追従する。
     */
    record Grid(int sourceWidth, int sourceHeight, int sourceSlices,
                double scaleX, double scaleY, double scaleZ,
                double originX, double originY, double originZ,
                double[] sourceSpacing, double[] targetSpacing) {

        static Grid of(int w, int h, int s, int newW, int newH, int newS,
                       double[] sourceSpacing, double[] targetSpacing) {
            double sx = sourceSpacing[0] / targetSpacing[0];
            double sy = sourceSpacing[1] / targetSpacing[1];
            double sz = sourceSpacing[2] / targetSpacing[2];
            return new Grid(w, h, s, sx, sy, sz,
                    Utils.gridOrigin(w, newW, sx),
                    Utils.gridOrigin(h, newH, sy),
                    Utils.gridOrigin(s, newS, sz),
                    sourceSpacing, targetSpacing);
        }
    }

    /**
     * 設定から目標ボクセル間隔 (x,y,z) mm を読む。{@code Resampling_BOOL} が false なら
     * null（＝リサンプリングしない）。未設定の軸は {@link #DEFAULT_SPACING_MM} を使う。
     */
    static double[] targetSpacing(Map<String, String> settings) {
        if (!boolOf(settings, "Resampling_BOOL", false)) return null;
        double x = doubleOf(settings, "ResamplingX_DOUBLE", DEFAULT_SPACING_MM);
        double y = doubleOf(settings, "ResamplingY_DOUBLE", DEFAULT_SPACING_MM);
        double z = doubleOf(settings, "ResamplingZ_DOUBLE", DEFAULT_SPACING_MM);
        if (x <= 0 || y <= 0 || z <= 0) {
            throw new IllegalArgumentException(String.format(
                    "リサンプリングの目標ボクセル間隔に 0 以下が指定されています (%s, %s, %s mm)。"
                            + "環境設定 ▸ テクスチャ ▸ リサンプリング の X/Y/Z に正の mm を入れてください。",
                    num(x), num(y), num(z)));
        }
        if (x < MIN_SPACING_MM || y < MIN_SPACING_MM || z < MIN_SPACING_MM) {
            throw new IllegalArgumentException(String.format(
                    "リサンプリングの目標間隔が細かすぎます (%.3f, %.3f, %.3f mm)。%.2f mm 以上にしてください。",
                    x, y, z, MIN_SPACING_MM));
        }
        return new double[]{x, y, z};
    }

    /** {@code DerivationDescription} に書く 1 行。派生シリーズだけ見て後から辿れるようにする。 */
    static String describe(Map<String, String> settings) {
        double[] t;
        try {
            t = targetSpacing(settings);
        } catch (IllegalArgumentException e) {
            return "invalid";
        }
        if (t == null) return "off";
        return num(t[0]) + "x" + num(t[1]) + "x" + num(t[2]) + "mm";
    }

    /** 末尾の 0 を落とした mm 表記（1.0000 → 1、0.6450 → 0.645）。 */
    private static String num(double v) {
        String s = String.format("%.4f", v);
        s = s.replaceAll("0+$", "");
        return s.endsWith(".") ? s.substring(0, s.length() - 1) : s;
    }

    /** 元 spacing が目標と（数値誤差の範囲で）一致していればリサンプリング不要。 */
    static boolean alreadyMatches(double[] source, double[] target) {
        for (int i = 0; i < 3; i++) {
            double tolerance = 1e-4 * Math.max(source[i], target[i]);
            if (Math.abs(source[i] - target[i]) > tolerance) return false;
        }
        return true;
    }

    /**
     * ボクセル数の増え方を確かめる。桁で増える指定は、GLAM だと計算が時間単位になるので断る。
     *
     * @return 予定される格子 {newW, newH, newS}
     */
    static int[] plan(int w, int h, int s, double[] source, double[] target) {
        int newW = (int) Math.ceil(w * (source[0] / target[0]));
        int newH = (int) Math.ceil(h * (source[1] / target[1]));
        int newS = (int) Math.ceil(s * (source[2] / target[2]));
        if (newW < 1 || newH < 1 || newS < 1) {
            throw new IllegalArgumentException("リサンプリング後の格子が空になります。目標間隔を見直してください。");
        }
        double growth = ((double) newW * newH * newS) / ((double) w * h * s);
        if (growth > MAX_VOXEL_GROWTH) {
            throw new IllegalArgumentException(String.format(
                    "リサンプリングでボクセル数が %.1f 倍（%dx%dx%d → %dx%dx%d）になります。"
                            + "特徴計算はボクセル数に比例して伸びるので、目標間隔を粗くしてください"
                            + "（元の間隔は %.4g, %.4g, %.4g mm です）。",
                    growth, w, h, s, newW, newH, newS, source[0], source[1], source[2]));
        }
        return new int[]{newW, newH, newS};
    }

    /**
     * 画像とマスクを目標間隔へ補間する。
     *
     * <p>マスクは {@code Utils.resample3D} が<b>ラベル 1 の二値しか受け付けない</b>ため、
     * 一旦 1 へ寄せてから補間し、元のラベル値へ戻す（部分体積しきい値はライブラリが適用する）。
     *
     * @return {@code {resampledImage, resampledMask}}
     */
    static ImagePlus[] resample(ImagePlus img, ImagePlus mask, int label, double[] target) {
        Calibration cal = img.getCalibration().copy();
        // マスクは自前で組み立てているので校正が入っていない。これを渡さないと、
        // ライブラリが 1mm 等方だと思い込んで画像と違う格子へ落ちる。
        ImagePlus mask1 = relabel(mask, label, 1);
        mask1.setCalibration(cal.copy());

        ImagePlus rImg = Utils.resample3D(img, false, target[0], target[1], target[2]);
        ImagePlus rMask = Utils.resample3D(mask1, true, target[0], target[1], target[2],
                RadiomicsJ.interpolation_mask3D);
        if (rImg == null || rMask == null) {
            throw new IllegalStateException("リサンプリングに失敗しました（RadiomicsJ が null を返しました）。");
        }
        ImagePlus outMask = relabel(rMask, RadiomicsJ.label_, label);
        outMask.setCalibration(rImg.getCalibration().copy());
        return new ImagePlus[]{rImg, outMask};
    }

    /** マスクのラベル値を差し替える（{@code from} 以上を {@code to}、それ以外を 0 にした ByteProcessor）。 */
    private static ImagePlus relabel(ImagePlus mask, int from, int to) {
        int w = mask.getWidth();
        int h = mask.getHeight();
        int n = mask.getNSlices();
        int hit = Math.max(1, Math.min(255, from));
        int value = Math.max(1, Math.min(255, to));
        ImageStack out = new ImageStack(w, h);
        for (int z = 0; z < n; z++) {
            ImageProcessor ip = mask.getStack().getProcessor(z + 1);
            ByteProcessor bp = new ByteProcessor(w, h);
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    bp.set(x, y, ip.getf(x, y) >= hit ? value : 0);
                }
            }
            out.addSlice(bp);
        }
        ImagePlus result = new ImagePlus(mask.getTitle(), out);
        result.setCalibration(mask.getCalibration().copy());
        return result;
    }

    /**
     * リサンプリング格子で得たマップを、元シリーズの格子へ戻す（Trilinear）。
     *
     * @param map 計算結果 {@code [z][width*height]}（リサンプリング格子）
     */
    static float[][] toSourceGrid(float[][] map, int width, int height, int slices, Grid g) {
        int sw = g.sourceWidth();
        int sh = g.sourceHeight();
        int ss = g.sourceSlices();
        float[][] out = new float[ss][sw * sh];
        for (int z = 0; z < ss; z++) {
            double fz = (z - g.originZ()) * g.scaleZ();
            float[] dst = out[z];
            for (int y = 0; y < sh; y++) {
                double fy = (y - g.originY()) * g.scaleY();
                for (int x = 0; x < sw; x++) {
                    double fx = (x - g.originX()) * g.scaleX();
                    dst[y * sw + x] = sample(map, width, height, slices, fx, fy, fz);
                }
            }
        }
        return out;
    }

    /** {@code [z][w*h]} の Trilinear サンプル。範囲外は端で丸める（ライブラリの補間と同じ扱い）。 */
    private static float sample(float[][] map, int w, int h, int s, double fx, double fy, double fz) {
        double cx = clamp(fx, 0, w - 1);
        double cy = clamp(fy, 0, h - 1);
        double cz = clamp(fz, 0, s - 1);
        int x0 = (int) Math.floor(cx);
        int y0 = (int) Math.floor(cy);
        int z0 = (int) Math.floor(cz);
        int x1 = Math.min(x0 + 1, w - 1);
        int y1 = Math.min(y0 + 1, h - 1);
        int z1 = Math.min(z0 + 1, s - 1);
        double dx = cx - x0;
        double dy = cy - y0;
        double dz = cz - z0;
        double c00 = lerp(map[z0][y0 * w + x0], map[z0][y0 * w + x1], dx);
        double c10 = lerp(map[z0][y1 * w + x0], map[z0][y1 * w + x1], dx);
        double c01 = lerp(map[z1][y0 * w + x0], map[z1][y0 * w + x1], dx);
        double c11 = lerp(map[z1][y1 * w + x0], map[z1][y1 * w + x1], dx);
        return (float) lerp(lerp(c00, c10, dy), lerp(c01, c11, dy), dz);
    }

    private static double lerp(double a, double b, double t) {
        return a + (b - a) * t;
    }

    private static double clamp(double v, double lo, double hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private static boolean boolOf(Map<String, String> s, String key, boolean def) {
        String v = (s == null) ? null : s.get(key);
        if (v == null || v.isBlank()) return def;
        String t = v.trim();
        if ("1".equals(t)) return true;
        if ("0".equals(t)) return false;
        return Boolean.parseBoolean(t);
    }

    private static double doubleOf(Map<String, String> s, String key, double def) {
        String v = (s == null) ? null : s.get(key);
        if (v == null || v.isBlank()) return def;
        try {
            double d = Double.parseDouble(v.trim());
            return Double.isNaN(d) ? def : d;
        } catch (NumberFormatException e) {
            return def;
        }
    }
}
