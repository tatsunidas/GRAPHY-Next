/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import ij.ImagePlus;
import ij.process.ImageProcessor;
import io.github.tatsunidas.radiomics.features.GLAMFeatureType;
import io.github.tatsunidas.radiomics.features.GLAMFeatures;
import io.github.tatsunidas.radiomics.features.GLAMMatrixType;
import io.github.tatsunidas.radiomics.features.RadiomicsFeature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * GLAM 解析 — ROI 全体を 1 つの領域として見て、記述子そのもの（動径分布関数と親和性行列）を返す。
 *
 * <p><b>可視化マップとの違い</b>: マップは窓ごとに GLAM を回すので、窓の外は見えない。
 * カーネル 7 なら maxRadius は 3 に頭打ちされ、r=1..3 しか観測できず、GLAM の売りである
 * 「数〜数十ボクセルの長距離構造」はほぼ落ちる。こちらはカーネルが無いので maxRadius を
 * 30〜50 まで取れる。「この組織は何 mm で自己相関を失うか」はここでしか読めない。
 *
 * <p>計算は ROI ボクセル対の総当たりで <b>O(n²)</b>。実測（RadiomicsJ の記録）で
 * 8,000 ボクセル 0.7 秒 / 125,000 ボクセル 22.4 秒。大きな ROI は
 * {@code INT_GLAM_maxReferenceVoxels} で中心ボクセルを間引く（113,000 → 1,000 で約 3 倍速く、
 * 第二ビリアル係数のズレは 0.15%）。既定は RadiomicsJ に合わせて<b>間引かない</b>ままにし、
 * 現実的でない大きさは {@link #MAX_ESTIMATED_PAIRS} で断る — 黙って何分も待たせないため。
 */
@Service
public class GlamAnalysisService {

    private static final Logger log = LoggerFactory.getLogger(GlamAnalysisService.class);

    /** 動径分布を見る最大距離の既定（ボクセル）。 */
    private static final int DEFAULT_MAX_RADIUS = 30;

    /**
     * 受け付けるボクセル対の上限。実測 7e8 対/秒あたりなので、およそ 60 秒ぶんで切る。
     * これを超える要求は、間引きか ROI 縮小を促して断る。
     */
    private static final double MAX_ESTIMATED_PAIRS = 4.2e10;

    /** 実測から得た処理速度（対/秒）。所要見積りの表示にだけ使う。 */
    private static final double PAIRS_PER_SECOND = 7e8;

    private final RadiomicsMapEngine engine;

    public GlamAnalysisService(RadiomicsMapEngine engine) {
        this.engine = engine;
    }

    /** ROI 全体で GLAM を 1 回計算し、記述子を返す。 */
    public GlamAnalysis analyze(GlamAnalysisRequest req) throws IOException {
        validate(req);

        int label = labelOf(req.settings());
        RadiomicsMapEngine.LoadedVolume vol = engine.load(req.studyInstanceUid(), req.sourceSeriesUid(),
                req.channel(), req.timePoint(), req.maskSeriesUid(), req.maskChannel(), label);

        if (vol.slices() < 2) {
            throw new IllegalArgumentException(
                    "GLAM は 3D 専用です。ターゲットのスライスが " + vol.slices() + " 枚しかありません。");
        }

        long roiVoxels = countRoiVoxels(vol.mask(), label);
        if (roiVoxels < 2) {
            throw new IllegalArgumentException("ROI が空です。マスクシリーズとラベル値を確認してください。");
        }

        int maxRadius = Math.max(2, req.maxRadius() != null ? req.maxRadius() : DEFAULT_MAX_RADIUS);
        int references = referenceVoxelsOf(req.settings(), roiVoxels);
        double pairs = (double) roiVoxels * references;
        if (pairs > MAX_ESTIMATED_PAIRS) {
            throw new IllegalArgumentException(String.format(
                    "ROI が大きすぎます（%,d ボクセル、推定 %.0f 分）。GLAM は ROI のボクセル対を"
                            + "総当たりするため計算量がボクセル数の 2 乗で増えます。環境設定 ▸ テクスチャ の"
                            + "「濃度値あたりの中心ボクセル数」に 2000 程度を設定して間引くか、ROI を小さくしてください"
                            + "（実測では 1000 まで間引いても第二ビリアル係数のズレは 0.15%% でした）。",
                    roiVoxels, pairs / PAIRS_PER_SECOND / 60.0));
        }

        boolean useBinCount = boolOf(req.settings(), "BINCOUNT_GLAM_BOOL", true);
        int nBins = intOf(req.settings(), "BINCOUNT_GLAM_INT", 16);
        Double binWidth = doubleOrNull(req.settings(), "BINWIDTH_GLAM_DOUBLE");

        double[] spacing = {
                vol.calibration().pixelWidth, vol.calibration().pixelHeight, vol.calibration().pixelDepth };
        boolean isotropic = isIsotropic(spacing);
        log.info("[glam-analysis] roi={} voxels, nBins={}, maxRadius={}, references={}, spacing=({}, {}, {}){}",
                roiVoxels, nBins, maxRadius, references, spacing[0], spacing[1], spacing[2],
                isotropic ? "" : " ※非等方");

        long t0 = System.currentTimeMillis();
        GlamAnalysis result;
        try {
            result = GlamMapSupport.runWithSettings(req.settings(), () -> {
                GLAMFeatures glam = new GLAMFeatures(vol.image(), vol.mask(), label, useBinCount,
                        nBins, binWidth, maxRadius);
                return extract(glam, vol, label, roiVoxels, spacing, isotropic, req.settings());
            });
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("GLAM 解析に失敗しました: " + e.getMessage(), e);
        }
        log.info("[glam-analysis] done in {} ms", System.currentTimeMillis() - t0);
        return result;
    }

    /** 計算済みの {@link GLAMFeatures} から記述子を取り出す。 */
    private GlamAnalysis extract(GLAMFeatures glam, RadiomicsMapEngine.LoadedVolume vol, int label,
                                 long roiVoxels, double[] spacing, boolean isotropic,
                                 Map<String, String> requested) {
        int bins = glam.getNumberOfBins();
        int radius = glam.getMaxRadius();

        int[] radii = new int[radius];
        for (int r = 0; r < radius; r++) {
            radii[r] = r + 1;
        }

        // g[r][alpha][beta]（r は 1 始まりで、添字 0 は未使用）から自己ペアだけ取り出す。
        double[][][] rdf = glam.getRadialDistributionFunction();
        double[][][] rdfRandom = glam.getRandomRadialDistributionFunction();
        double[][] self = new double[bins][radius];
        double[][] selfRandom = new double[bins][radius];
        for (int alpha = 0; alpha < bins; alpha++) {
            for (int r = 1; r <= radius; r++) {
                self[alpha][r - 1] = rdf[r][alpha][alpha];
                selfRandom[alpha][r - 1] = rdfRandom[r][alpha][alpha];
            }
        }

        // 19 行列。遅延構築なので、ここで初めてすべて組み上がる。
        Map<String, double[][]> matrices = new LinkedHashMap<>();
        List<String> diagonalOnly = new ArrayList<>();
        for (GLAMMatrixType type : GLAMMatrixType.values()) {
            matrices.put(type.name(), glam.getMatrix(type));
            if (type.isDiagonalOnly()) {
                diagonalOnly.add(type.name());
            }
        }

        long[] occupancy = binOccupancy(glam, vol.mask(), label, bins);

        Map<String, String> used = new LinkedHashMap<>(requested == null ? Map.of() : requested);
        used.put("BINCOUNT_GLAM_INT", String.valueOf(bins));
        used.put("INT_GLAM_maxRadius", String.valueOf(radius));

        return new GlamAnalysis(GLAMFeatureType.values().length, bins, radius, roiVoxels, occupancy, radii,
                self, selfRandom, matrices, diagonalOnly, spacing, isotropic, used);
    }

    /**
     * ビンごとのボクセル数。<b>稀なビンほど g(r) は跳ねる</b>ので、曲線を読む前に確認が要る。
     *
     * <p>離散化後の画像は {@code getSettings()} から取れる。ROI 内は 1..nBins、外は NaN。
     */
    private static long[] binOccupancy(GLAMFeatures glam, ImagePlus mask, int label, int bins) {
        long[] occupancy = new long[bins];
        Object disc = glam.getSettings().get(RadiomicsFeature.DISC_IMG);
        if (!(disc instanceof ImagePlus discImg)) {
            return occupancy;
        }
        for (int z = 0; z < discImg.getNSlices(); z++) {
            ImageProcessor dp = discImg.getStack().getProcessor(z + 1);
            ImageProcessor mp = mask.getStack().getProcessor(z + 1);
            for (int y = 0; y < dp.getHeight(); y++) {
                for (int x = 0; x < dp.getWidth(); x++) {
                    if ((int) mp.getf(x, y) != label) continue;
                    float v = dp.getf(x, y);
                    if (Float.isNaN(v)) continue;
                    int index = (int) v - 1; // 離散値は 1 始まり
                    if (index >= 0 && index < bins) occupancy[index]++;
                }
            }
        }
        return occupancy;
    }

    private static long countRoiVoxels(ImagePlus mask, int label) {
        long count = 0;
        for (int z = 0; z < mask.getNSlices(); z++) {
            ImageProcessor mp = mask.getStack().getProcessor(z + 1);
            for (int y = 0; y < mp.getHeight(); y++) {
                for (int x = 0; x < mp.getWidth(); x++) {
                    if ((int) mp.getf(x, y) == label) count++;
                }
            }
        }
        return count;
    }

    private static void validate(GlamAnalysisRequest req) {
        if (req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.sourceSeriesUid() == null || req.sourceSeriesUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / sourceSeriesUid は必須です");
        }
        if (req.maskSeriesUid() == null || req.maskSeriesUid().isBlank()) {
            // 全面を ROI にすると、動径分布が組織ではなく画像の外形を測ってしまう
            throw new IllegalArgumentException("GLAM 解析には ROI マスクシリーズが必要です。");
        }
    }

    /** 実際に中心として使われるボクセル数（0＝間引かない＝ROI 全体）。 */
    private static int referenceVoxelsOf(Map<String, String> settings, long roiVoxels) {
        int configured = intOf(settings, "INT_GLAM_maxReferenceVoxels", 0);
        if (configured <= 0) {
            return (int) Math.min(Integer.MAX_VALUE, roiVoxels);
        }
        return (int) Math.min(configured, roiVoxels);
    }

    private static boolean isIsotropic(double[] spacing) {
        double tolerance = 1e-3 * Math.max(spacing[0], Math.max(spacing[1], spacing[2]));
        return Math.abs(spacing[0] - spacing[1]) <= tolerance && Math.abs(spacing[0] - spacing[2]) <= tolerance;
    }

    private static int labelOf(Map<String, String> settings) {
        return intOf(settings, "MASK_LABEL_INT", 1);
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

    private static boolean boolOf(Map<String, String> s, String key, boolean def) {
        String v = (s == null) ? null : s.get(key);
        if (v == null || v.isBlank()) return def;
        String t = v.trim();
        if ("1".equals(t)) return true;
        if ("0".equals(t)) return false;
        return Boolean.parseBoolean(t);
    }

    private static Double doubleOrNull(Map<String, String> s, String key) {
        String v = (s == null) ? null : s.get(key);
        if (v == null || v.isBlank()) return null;
        try {
            double d = Double.parseDouble(v.trim());
            return Double.isNaN(d) ? null : d;
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
