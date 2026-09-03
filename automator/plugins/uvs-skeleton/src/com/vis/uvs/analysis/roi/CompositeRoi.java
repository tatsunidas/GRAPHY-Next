package com.vis.uvs.analysis.roi;

import ij.gui.Roi;
import ij.process.ImageStatistics;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Point;

/**
 * 差分とオプティカルフローを合成した ROI スコアリングと特徴抽出（既定の抽出器）。
 *
 * <p>Swing 版 {@code methods/RoiScorerComposite} と
 * {@code methods/CompositeFeatureExtractor} の移植。
 */
public final class CompositeRoi {

    private static final Logger log = LoggerFactory.getLogger(CompositeRoi.class);

    private CompositeRoi() {
    }

    private static final String[] FEATURE_NAMES = {
            OpticalFlowRoi.OF_PHASE_VARIANCE,
            OpticalFlowRoi.OF_MAGNITUDE_MEAN,
            SubtractionRoi.GRAY_VARIANCE,
            SubtractionRoi.GRAY_MEAN,
            SubtractionRoi.CENTER_X,
            SubtractionRoi.CENTER_Y};

    /**
     * 差分スコアとフロースコアの<b>積</b>。
     *
     * <p>「明るさが変わっていて、かつ動いている」領域を強調する。
     * どちらかが非有限なら NaN を返す（Swing と同じ）。
     */
    public static final class Scorer implements RoiScorer {

        private final RoiScorer subtraction;
        private final RoiScorer flow;

        public Scorer(RoiScorer subtraction, RoiScorer flow) {
            this.subtraction = subtraction;
            this.flow = flow;
        }

        @Override
        public double score(Roi roi) {
            double s1 = subtraction.score(roi);
            double s2 = flow.score(roi);
            if (Double.isFinite(s1) && Double.isFinite(s2)) {
                return s1 * s2;
            }
            log.warn("複合スコアに NaN / Infinity が現れました。NaN を返します");
            return Double.NaN;
        }
    }

    /** 6 次元（フロー 2 ＋ 差分 2 ＋ 中心 2）。 */
    public static final class FeatureExtractor implements RoiFeatureExtractor {

        private final SubtractionRoi.FeatureExtractor subtraction;
        private final OpticalFlowRoi.FeatureExtractor flow;

        public FeatureExtractor(SubtractionRoi.FeatureExtractor subtraction,
                                OpticalFlowRoi.FeatureExtractor flow) {
            this.subtraction = subtraction;
            this.flow = flow;
        }

        @Override
        public RoiFeatureVector extract(Roi roi) {
            if (subtraction == null || flow == null || roi == null) {
                return null;
            }
            double[] mp = flow.magnitudeAndPhaseVariance(roi);
            ImageStatistics stats = subtraction.stats(roi);
            Point c = center(roi);

            RoiFeatureVector v = new RoiFeatureVector(FEATURE_NAMES, new double[]{
                    mp[1],                          // OF_Phase_Variance
                    mp[0],                          // OF_Magnitude_Mean
                    Math.pow(stats.stdDev, 2),      // GrayVariance
                    stats.mean,                     // GrayMean
                    c.x,
                    c.y});
            return v.isFinite() ? v : null;
        }
    }
}
