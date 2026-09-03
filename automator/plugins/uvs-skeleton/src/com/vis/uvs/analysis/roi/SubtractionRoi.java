package com.vis.uvs.analysis.roi;

import ij.gui.Roi;
import ij.plugin.filter.GaussianBlur;
import ij.process.ImageProcessor;
import ij.process.ImageStatistics;

import java.awt.Point;
import java.awt.Rectangle;

/**
 * フレーム差分に基づく ROI スコアリングと特徴抽出。
 *
 * <p>Swing 版 {@code methods/RoiScorerFrameSubtration} と
 * {@code methods/FrameSubtractionFeatureExtractor} の移植
 * （{@code fw/analysis-pipeline.md} §3.5・§3.6）。
 */
public final class SubtractionRoi {

    private SubtractionRoi() {
    }

    public static final String GRAY_VARIANCE = "GrayVariance";
    public static final String GRAY_MEAN = "GrayMean";
    public static final String CENTER_X = "Center_X";
    public static final String CENTER_Y = "Center_Y";

    private static final String[] FEATURE_NAMES = {GRAY_VARIANCE, GRAY_MEAN, CENTER_X, CENTER_Y};

    /**
     * スコアラ。ROI 内の平均輝度 × 面積（＝絶対値の総和と同義）。
     *
     * <p><b>性能上の変更（結果は同一）</b>: Swing は ROI ごとに
     * 「差分画像を複製 → Gaussian σ=3 → abs()」を実行していた。ボックスは 150〜300 個あるので
     * 同じ前処理を毎回やり直していたことになる。前処理は ROI に依存しないため、
     * <b>1 フレームにつき 1 回だけ</b>行うようコンストラクタへ引き上げた。
     */
    public static final class Scorer implements RoiScorer {

        private final ImageProcessor blurredAbs;

        /**
         * @param subtraction 差分画像（{@code frame[i+stride] - frame[i]}、符号付き float）
         * @param sigma       Gaussian のσ（既定 3.0）
         */
        public Scorer(ImageProcessor subtraction, double sigma) {
            ImageProcessor fp = subtraction.duplicate();
            new GaussianBlur().blurGaussian(fp, sigma);
            fp.abs();
            fp.resetRoi();
            this.blurredAbs = fp;
        }

        @Override
        public double score(Roi roi) {
            blurredAbs.resetRoi();
            blurredAbs.setRoi(roi);
            ImageStatistics stats = blurredAbs.getStats();
            blurredAbs.resetRoi();
            Rectangle b = roi.getBounds();
            return stats.mean * b.width * b.height;
        }

        /** 検査表示用（Check: candidateArea）。 */
        public ImageProcessor blurredAbs() {
            return blurredAbs;
        }
    }

    /**
     * 特徴抽出。<b>ぼかしていない生の差分画像</b>を使う（Swing と同じ）。
     */
    public static final class FeatureExtractor implements RoiFeatureExtractor {

        private final ImageProcessor subtraction;

        public FeatureExtractor(ImageProcessor subtraction) {
            this.subtraction = subtraction;
        }

        @Override
        public RoiFeatureVector extract(Roi roi) {
            if (subtraction == null || roi == null) {
                return null;
            }
            subtraction.resetRoi();
            subtraction.setRoi(roi);
            ImageStatistics stats = subtraction.getStats();
            subtraction.resetRoi();

            double variance = Math.pow(stats.stdDev, 2);
            double mean = stats.mean;
            Point c = center(roi);

            RoiFeatureVector v = new RoiFeatureVector(FEATURE_NAMES,
                    new double[]{variance, mean, c.x, c.y});
            return v.isFinite() ? v : null;
        }

        /** 統計だけが要る場合（複合抽出器から使う）。 */
        public ImageStatistics stats(Roi roi) {
            subtraction.resetRoi();
            subtraction.setRoi(roi);
            ImageStatistics stats = subtraction.getStats();
            subtraction.resetRoi();
            return stats;
        }
    }
}
