/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.locks.ReentrantLock;

/**
 * GLAM（Gray Level Affinity Metrics）を可視化マップで回すための前提と後始末。
 *
 * <p>GLAM は他の族と性格が違い、そのまま繋ぐと成立しない点が 3 つある。設計
 * {@code fw/texture-radiomics-design.md} §11。
 *
 * <ol>
 *   <li><b>パラメータの大半が RadiomicsJ の static フィールド</b>にある（{@code RadiomicsJ.glam*}）。
 *       {@code Map} コンストラクタから渡せるのは {@code GLAM_MAX_RADIUS} だけなので、
 *       残りは計算前に static へ書き、終わったら必ず戻す。プロセス広域の状態なので
 *       {@link #runWithSettings} が<b>ロックで直列化</b>する。</li>
 *   <li><b>既定の maxRadius は 100</b>。カーネル 7 の窓に 100 ボクセル先は存在しないうえ、
 *       {@code [maxRadius+1][nBins][nBins]} を 3 本確保するので 1 窓あたり約 620KB を捨てる。
 *       {@link #maxRadiusFor} が<b>カーネル半径で頭打ち</b>にする。</li>
 *   <li><b>3D 専用</b>（{@code requireVolume()} が例外を投げる）で、<b>等方ボクセル前提</b>。
 *       例外は {@code FeatureCalculatorFactory} が {@code RuntimeException} に包んで投げ、
 *       マップ側は各ボクセルを 0 にして握り潰すため、<b>全面ゼロのマップが黙って出来上がる</b>。
 *       だから前提は {@link #validate} で先に弾く。</li>
 * </ol>
 */
final class GlamMapSupport {

    private static final Logger log = LoggerFactory.getLogger(GlamMapSupport.class);

    /** 特徴文字列のファミリー接頭辞。 */
    static final String FAMILY = "GLAM";

    /** GLAM に必要な最小カーネル径（maxRadius が 2 以上になる最小）。 */
    static final int MIN_FILTER_SIZE = 5;

    /**
     * 1 窓あたりの実測所要（ms, カーネル 7・8 コア）。所要見積りの基準。
     * 実測は {@code RadiomicsJ/src/test/java/radiomics/GLAMMapBenchmark.java}。
     */
    private static final double MS_PER_WINDOW_AT_KERNEL_7 = 0.31;

    /** カーネル径に対する伸び。窓内の全ボクセル対を歩くので概ね 6 乗。 */
    private static final double KERNEL_EXPONENT = 6.0;

    /**
     * {@code RadiomicsJ.glam*} はプロセス広域なので、GLAM のマップ計算は一度に 1 本だけ走らせる。
     * 他の族は static を読まないため影響を受けない。
     */
    private static final ReentrantLock GLAM_LOCK = new ReentrantLock();

    private GlamMapSupport() {}

    /** 特徴文字列が GLAM 族か。 */
    static boolean isGlam(String feature) {
        return feature != null && feature.toUpperCase().startsWith(FAMILY + "_");
    }

    /**
     * 窓内で意味を持つ最大距離。設定値があっても<b>カーネル半径を超えさせない</b>。
     *
     * @param filterSize カーネル径（奇数）
     * @param settings   GRAPHY Property キー→値。{@code INT_GLAM_maxRadius} が 0/未指定なら自動
     */
    static int maxRadiusFor(int filterSize, Map<String, String> settings) {
        int fromKernel = filterSize / 2;
        int configured = intOf(settings, "INT_GLAM_maxRadius", 0);
        int radius = (configured > 0) ? Math.min(configured, fromKernel) : fromKernel;
        return Math.max(2, radius);
    }

    /**
     * GLAM で回せる要求かを確かめる。通らないものは <b>0 で埋まったマップを返す前に</b>弾く。
     *
     * @param slices     ターゲットのスライス数
     * @param hasMask    マスクシリーズが指定されているか
     * @param isotropicWarning 非等方ボクセルの説明（等方なら null）
     */
    static void validate(TextureSeriesRequest req, int slices, boolean hasMask, String isotropicWarning) {
        if (req.force2D()) {
            throw new IllegalArgumentException(
                    "GLAM は 3D 専用です（球殻上の動径分布として定義されているため）。計算次元を 3D にしてください。");
        }
        if (slices < 2) {
            throw new IllegalArgumentException(
                    "GLAM は 3D 専用です。ターゲットのスライスが " + slices + " 枚しかありません。");
        }
        if (req.filterSize() > 0 && req.filterSize() < MIN_FILTER_SIZE) {
            throw new IllegalArgumentException(
                    "GLAM のカーネル径は " + MIN_FILTER_SIZE + " 以上が必要です（指定 " + req.filterSize()
                            + "）。GLAM は距離ごとの構造を見る特徴なので、窓が小さいと見るべき距離が残りません。");
        }
        if (!hasMask) {
            // 全面マスクだと窓数が桁違いになる。512x512x100 を stride 3 で回すと約 290 万窓＝カーネル 7 でも 15 分。
            throw new IllegalArgumentException(
                    "GLAM はマスクシリーズが必須です。全面マスクでは窓数が現実的でない規模になります"
                            + "（ROI を指定してください）。");
        }
        if (isotropicWarning != null) {
            log.warn("[texture][GLAM] {}", isotropicWarning);
        }
    }

    /**
     * 所要の見積り（ms）。実測した 1 窓あたりの単価をカーネル径で伸ばして窓数に掛ける。
     * 桁を示すためのもので、精度は期待しない。
     */
    static long estimateMillis(long windowCount, int filterSize) {
        double perWindow = MS_PER_WINDOW_AT_KERNEL_7 * Math.pow(filterSize / 7.0, KERNEL_EXPONENT);
        return Math.round(windowCount * perWindow);
    }

    /**
     * {@code RadiomicsJ.glam*} を設定値で上書きして {@code body} を走らせ、<b>必ず元へ戻す</b>。
     * static はプロセス広域なので、この間ほかの GLAM 計算は待たせる。
     */
    static <T> T runWithSettings(Map<String, String> settings, Callable<T> body) throws Exception {
        GLAM_LOCK.lock();
        Integer savedMaxRadius = RadiomicsJ.glamMaxRadius;
        Integer savedMaxReferenceVoxels = RadiomicsJ.glamMaxReferenceVoxels;
        Boolean savedBoundaryCorrection = RadiomicsJ.glamBoundaryCorrection;
        Integer savedNumRandomisations = RadiomicsJ.glamNumRandomisations;
        Long savedRandomSeed = RadiomicsJ.glamRandomSeed;
        Integer savedSavitzkyGolayWindow = RadiomicsJ.glamSavitzkyGolayWindow;
        Integer savedSavitzkyGolayPolynomial = RadiomicsJ.glamSavitzkyGolayPolynomial;
        Double savedPeakProminence = RadiomicsJ.glamPeakProminence;
        Integer savedMaxLocalShellRadius = RadiomicsJ.glamMaxLocalShellRadius;
        try {
            RadiomicsJ.glamMaxReferenceVoxels = intOf(settings, "INT_GLAM_maxReferenceVoxels", savedMaxReferenceVoxels);
            RadiomicsJ.glamBoundaryCorrection = boolOf(settings, "BOOL_GLAM_boundaryCorrection", savedBoundaryCorrection);
            RadiomicsJ.glamNumRandomisations = intOf(settings, "INT_GLAM_numRandomisations", savedNumRandomisations);
            RadiomicsJ.glamRandomSeed = longOf(settings, "LONG_GLAM_randomSeed", savedRandomSeed);
            RadiomicsJ.glamSavitzkyGolayWindow = intOf(settings, "INT_GLAM_savitzkyGolayWindow", savedSavitzkyGolayWindow);
            RadiomicsJ.glamSavitzkyGolayPolynomial =
                    intOf(settings, "INT_GLAM_savitzkyGolayPolynomial", savedSavitzkyGolayPolynomial);
            RadiomicsJ.glamPeakProminence = doubleOf(settings, "DOUBLE_GLAM_peakProminence", savedPeakProminence);
            RadiomicsJ.glamMaxLocalShellRadius =
                    intOf(settings, "INT_GLAM_maxLocalShellRadius", savedMaxLocalShellRadius);
            log.info("[texture][GLAM] boundaryCorrection={} maxReferenceVoxels={} randomisations={} sgWindow={} sgPoly={} prominence={} localShell={}",
                    RadiomicsJ.glamBoundaryCorrection, RadiomicsJ.glamMaxReferenceVoxels,
                    RadiomicsJ.glamNumRandomisations, RadiomicsJ.glamSavitzkyGolayWindow,
                    RadiomicsJ.glamSavitzkyGolayPolynomial, RadiomicsJ.glamPeakProminence,
                    RadiomicsJ.glamMaxLocalShellRadius);
            return body.call();
        } finally {
            RadiomicsJ.glamMaxRadius = savedMaxRadius;
            RadiomicsJ.glamMaxReferenceVoxels = savedMaxReferenceVoxels;
            RadiomicsJ.glamBoundaryCorrection = savedBoundaryCorrection;
            RadiomicsJ.glamNumRandomisations = savedNumRandomisations;
            RadiomicsJ.glamRandomSeed = savedRandomSeed;
            RadiomicsJ.glamSavitzkyGolayWindow = savedSavitzkyGolayWindow;
            RadiomicsJ.glamSavitzkyGolayPolynomial = savedSavitzkyGolayPolynomial;
            RadiomicsJ.glamPeakProminence = savedPeakProminence;
            RadiomicsJ.glamMaxLocalShellRadius = savedMaxLocalShellRadius;
            GLAM_LOCK.unlock();
        }
    }

    /**
     * 境界補正と相性の悪い行列。どちらも {@code ln g_random} で割るため、補正が入ると
     * 分母が分子に一致して 1 に張り付く（RadiomicsJ {@code GLAMMatrixType} の注記）。
     */
    static boolean dependsOnBoundaryCorrection(String feature) {
        if (feature == null) return false;
        return feature.contains("ConfigurationalDisorderIndex") || feature.contains("FrustrationIndex");
    }

    private static int intOf(Map<String, String> s, String key, int def) {
        String v = (s == null) ? null : s.get(key);
        if (v == null || v.isBlank()) return def;
        try {
            return (int) Math.round(Double.parseDouble(v.trim()));
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static long longOf(Map<String, String> s, String key, long def) {
        String v = (s == null) ? null : s.get(key);
        if (v == null || v.isBlank()) return def;
        try {
            return Long.parseLong(v.trim());
        } catch (NumberFormatException e) {
            return def;
        }
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

    private static boolean boolOf(Map<String, String> s, String key, boolean def) {
        String v = (s == null) ? null : s.get(key);
        if (v == null || v.isBlank()) return def;
        String t = v.trim();
        if ("1".equals(t)) return true;
        if ("0".equals(t)) return false;
        return Boolean.parseBoolean(t);
    }
}
