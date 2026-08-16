/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import ij.ImagePlus;
import ij.ImageStack;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import io.github.tatsunidas.radiomics.main.FeatureCalculator;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * GLAM の特徴文字列がカタログを通って実際に値を返すところまでの回帰テスト。
 *
 * <p>GLAM は 19 行列 × 8 統計 = 150 特徴あり、UI は行列と統計を別々に選ばせてから
 * {@code GLAM_<行列>_<統計>} に組み立てる。カタログは最初の {@code "_"} で族を切り出すので、
 * 残りがそのまま RadiomicsJ の enum 定数名になる、という前提の上に成り立っている。
 * ここが崩れると「未対応の特徴名です」で全部落ちる。
 */
class TextureFeatureCatalogGlamTest {

    /** 濃度値を立方体に並べたファントム。窓が構造を見られる程度の大きさにしてある。 */
    private static ImagePlus blocks(int w, int h, int d, int blockSize, int levels) {
        ImageStack stack = new ImageStack(w, h);
        for (int z = 0; z < d; z++) {
            FloatProcessor ip = new FloatProcessor(w, h);
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int block = (x / blockSize) + (y / blockSize) + (z / blockSize);
                    ip.setf(x, y, (block % levels) * 100f);
                }
            }
            stack.addSlice(ip);
        }
        ImagePlus imp = new ImagePlus("blocks", stack);
        imp.getCalibration().pixelWidth = 1d;
        imp.getCalibration().pixelHeight = 1d;
        imp.getCalibration().pixelDepth = 1d;
        return imp;
    }

    /** 濃度値をボクセル単位でばらまいたファントム。ヒストグラムは blocks と同系だが構造が無い。 */
    private static ImagePlus saltAndPepper(int w, int h, int d, int levels) {
        ImageStack stack = new ImageStack(w, h);
        // 決め打ちの疑似乱数。テストが実行のたびに違う絵を見ないようにする
        long state = 12345L;
        for (int z = 0; z < d; z++) {
            FloatProcessor ip = new FloatProcessor(w, h);
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    state = state * 6364136223846793005L + 1442695040888963407L;
                    int level = (int) Math.floorMod(state >> 33, levels);
                    ip.setf(x, y, level * 100f);
                }
            }
            stack.addSlice(ip);
        }
        ImagePlus imp = new ImagePlus("salt", stack);
        imp.getCalibration().pixelWidth = 1d;
        imp.getCalibration().pixelHeight = 1d;
        imp.getCalibration().pixelDepth = 1d;
        return imp;
    }

    private static ImagePlus fullMask(int w, int h, int d) {
        ImageStack stack = new ImageStack(w, h);
        for (int z = 0; z < d; z++) {
            ByteProcessor ip = new ByteProcessor(w, h);
            ip.setValue(1);
            ip.fill();
            stack.addSlice(ip);
        }
        return new ImagePlus("mask", stack);
    }

    private static Map<String, String> settings() {
        Map<String, String> s = new HashMap<>();
        s.put("MASK_LABEL_INT", "1");
        s.put("BINCOUNT_GLAM_BOOL", "true");
        s.put("BINCOUNT_GLAM_INT", "8");
        return s;
    }

    @Test
    void resolvesAMatrixAndStatisticIntoAWorkingCalculator() {
        TextureFeatureCatalog.BuiltFeature built =
                TextureFeatureCatalog.build("GLAM_SecondVirialCoefficient_Mean", settings(), 9);
        assertEquals("GLAM_SecondVirialCoefficient_Mean", built.displayName());

        ImagePlus image = blocks(9, 9, 9, 3, 4);
        Double value = built.calculator().calculate(image, fullMask(9, 9, 9));
        assertNotNull(value);
        assertTrue(Double.isFinite(value), "expected a finite value, got " + value);
    }

    @Test
    void resolvesEveryMatrixWithEveryStatistic() {
        // 19 行列 × 8 統計。UI がどれを選んでも「未対応の特徴名です」にならないことを押さえる。
        String[] matrices = {
                "RDFPeakPosition", "RDFDispersionRatio", "LogRDFPeakHeight", "LogRDFMedian", "LogRDFVariance",
                "LogRDFSkewness", "LogRDFKurtosis", "SecondVirialCoefficient", "PotentialEnergy", "Compressibility",
                "CoordinationNumber", "InverseCorrelationLength", "StructuralPressureIndex",
                "ConfigurationalDisorderIndex", "WassersteinDistance", "AssemblyCoupling", "PhenotypicDistance",
                "LocalPackingFraction", "FrustrationIndex",
        };
        String[] statistics = {"Mean", "Variance", "Skewness", "Kurtosis", "Minimum", "Maximum",
                "DiagonalMean", "OffDiagonalMean"};
        int resolved = 0;
        for (String matrix : matrices) {
            for (String statistic : statistics) {
                // Compressibility は自己ペアのみで、対角/非対角の統計を持たない（UI 側でも出さない）
                if ("Compressibility".equals(matrix)
                        && ("DiagonalMean".equals(statistic) || "OffDiagonalMean".equals(statistic))) {
                    continue;
                }
                String feature = "GLAM_" + matrix + "_" + statistic;
                assertNotNull(TextureFeatureCatalog.build(feature, settings(), 9), feature);
                resolved++;
            }
        }
        assertEquals(150, resolved);
    }

    @Test
    void rejectsAMatrixThatDoesNotExist() {
        assertThrows(IllegalArgumentException.class,
                () -> TextureFeatureCatalog.build("GLAM_NoSuchMatrix_Mean", settings(), 9));
    }

    @Test
    void separatesStructureThatAHistogramCannotSee() {
        /*
         * GLAM の売りは、一次統計では区別できない「並び方」を数値にすること。同じ 4 段階の濃度値で、
         * 片方は 3 ボクセル角の塊、片方はばらまきにして、その差が出ることを確かめる。
         *
         * 見るのは第二ビリアル係数の符号ではなく「偶然からの隔たり」。B2 は (g - g_random) を r^2 で
         * 重み付けして積分するため、遠距離の寄与が効き、周期的な塊模様では近距離の引力を遠距離の
         * 反発が上回って正になりうる。符号は模様の周期とカーネル径の兼ね合いで決まるので、
         * 「塊なら負」と決めつけると模様を少し変えただけで壊れる。
         *
         * 一方で、ばらまきは定義上どの距離でも g ≒ g_random になり、B2 は 0 の近くに落ちる
         * （RadiomicsJ の GLAM 解説が salt and pepper で g ≒ 1.000 になると書いているとおり）。
         * これは実装が正しく正規化できていることの確認にもなっている。
         */
        TextureFeatureCatalog.BuiltFeature built =
                TextureFeatureCatalog.build("GLAM_SecondVirialCoefficient_DiagonalMean", settings(), 11);
        FeatureCalculator calc = built.calculator();

        Double structured = calc.calculate(blocks(11, 11, 11, 3, 4), fullMask(11, 11, 11));
        Double random = calc.calculate(saltAndPepper(11, 11, 11, 4), fullMask(11, 11, 11));

        assertNotNull(structured);
        assertNotNull(random);
        assertTrue(Double.isFinite(structured) && Double.isFinite(random),
                "structured=" + structured + " random=" + random);
        // ばらまきは偶然と区別がつかない＝0 の近く
        assertTrue(Math.abs(random) < 5.0, "a random arrangement should sit near chance, got " + random);
        // 塊はそこから明確に離れる
        assertTrue(Math.abs(structured) > 5 * Math.abs(random),
                "blocks should be far from chance compared with a random arrangement: structured=" + structured
                        + " random=" + random);
    }

    @Test
    void otherFamiliesStillResolve() {
        // GLAM のためにカタログへ足した分岐が、既存の族を壊していないこと
        assertNotNull(TextureFeatureCatalog.build("GLCM_JointEntropy", settings(), 7));
        assertNotNull(TextureFeatureCatalog.build("HISTOGRAM_Entropy", settings(), 7));
        assertNotNull(TextureFeatureCatalog.build("FIRSTORDER_Mean", settings(), 7));
    }
}
