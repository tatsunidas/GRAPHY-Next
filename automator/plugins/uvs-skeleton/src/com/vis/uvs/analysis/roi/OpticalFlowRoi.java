package com.vis.uvs.analysis.roi;

import ij.gui.Roi;

import java.awt.Point;
import java.awt.Rectangle;

/**
 * オプティカルフローに基づく ROI スコアリングと特徴抽出。
 *
 * <p>Swing 版 {@code methods/RoiScorerOpticalFlow} と
 * {@code methods/OpticalFlowFeatureExtractor} の移植
 * （{@code fw/analysis-pipeline.md} §3.5・§3.6）。
 */
public final class OpticalFlowRoi {

    private OpticalFlowRoi() {
    }

    public static final String OF_MAGNITUDE_MEAN = "OF_Magnitude_Mean";
    public static final String OF_PHASE_VARIANCE = "OF_Phase_Variance";
    public static final String CENTER_X = "Center_X";
    public static final String CENTER_Y = "Center_Y";

    private static final String[] FEATURE_NAMES = {OF_MAGNITUDE_MEAN, OF_PHASE_VARIANCE, CENTER_X, CENTER_Y};

    /** ROI 内のマグニチュード総和。 */
    public static final class Scorer implements RoiScorer {

        private final double[][][] flow;

        public Scorer(double[][][] flow) {
            this.flow = flow;
        }

        @Override
        public double score(Roi roi) {
            Rectangle b = roi.getBounds();
            int imgH = flow.length;
            int imgW = flow[0].length;
            double sum = 0;
            for (int y = b.y; y < b.y + b.height; y++) {
                if (y < 0 || y >= imgH) {
                    continue;
                }
                for (int x = b.x; x < b.x + b.width; x++) {
                    if (x < 0 || x >= imgW) {
                        continue;
                    }
                    double du = flow[y][x][0];
                    double dv = flow[y][x][1];
                    sum += Math.sqrt(du * du + dv * dv);
                }
            }
            return sum;
        }
    }

    /**
     * 特徴抽出。マグニチュード平均と<b>位相の円周分散</b>。
     *
     * <p>円周分散 = {@code 1 - |mean(cosθ, sinθ)|}。0 なら向きが揃っている、1 ならバラバラ。
     * {@code atan2} で角度を出してから cos/sin に戻すのは重いので、
     * {@code (du, dv)} を長さで割って直接 cos/sin を得る（Swing の最適化をそのまま維持）。
     */
    public static final class FeatureExtractor implements RoiFeatureExtractor {

        private final double[][][] flow;

        public FeatureExtractor(double[][][] flow) {
            this.flow = flow;
        }

        /** @return {@code [meanMagnitude, circularVariance]}。画素が無ければ {@code NaN} 2 つ */
        public double[] magnitudeAndPhaseVariance(Roi roi) {
            Rectangle b = roi.getBounds();
            int imgH = flow.length;
            int imgW = flow[0].length;

            double sumMag = 0;
            double sumCos = 0;
            double sumSin = 0;
            int count = 0;

            for (int y = b.y; y < b.y + b.height; y++) {
                if (y < 0 || y >= imgH) {
                    continue;
                }
                for (int x = b.x; x < b.x + b.width; x++) {
                    if (x < 0 || x >= imgW) {
                        continue;
                    }
                    double du = flow[y][x][0];
                    double dv = flow[y][x][1];
                    double mag = Math.sqrt(du * du + dv * dv);
                    sumMag += mag;
                    if (mag > 0) {
                        sumCos += du / mag;
                        sumSin += dv / mag;
                    }
                    // ⚠ mag == 0 の画素も count に入る（Swing と同じ）
                    count++;
                }
            }

            if (count == 0) {
                return new double[]{Double.NaN, Double.NaN};
            }
            double meanMag = sumMag / count;
            double meanCos = sumCos / count;
            double meanSin = sumSin / count;
            double resultantLength = Math.sqrt(meanCos * meanCos + meanSin * meanSin);
            return new double[]{meanMag, 1.0 - resultantLength};
        }

        @Override
        public RoiFeatureVector extract(Roi roi) {
            if (flow == null || roi == null) {
                return null;
            }
            double[] mp = magnitudeAndPhaseVariance(roi);
            Point c = center(roi);
            RoiFeatureVector v = new RoiFeatureVector(FEATURE_NAMES,
                    new double[]{mp[0], mp[1], c.x, c.y});
            return v.isFinite() ? v : null;
        }
    }
}
