package com.vis.uvs.analysis.candidate;

import com.vis.uvs.analysis.AnalysisSettings;
import com.vis.uvs.analysis.flow.Farneback;
import com.vis.uvs.analysis.flow.FlowSettings;
import com.vis.uvs.analysis.flow.FlowSmoother;
import com.vis.uvs.analysis.roi.BoxGenerator;
import com.vis.uvs.analysis.roi.CompositeRoi;
import com.vis.uvs.analysis.roi.OpticalFlowRoi;
import com.vis.uvs.analysis.roi.RoiClusterPipeline;
import com.vis.uvs.analysis.roi.RoiFeatureExtractor;
import com.vis.uvs.analysis.roi.RoiScorer;
import com.vis.uvs.analysis.roi.RoiSettings;
import com.vis.uvs.analysis.roi.SubtractionRoi;
import com.vis.uvs.video.Frame;
import ij.gui.Roi;
import ij.process.FloatProcessor;

import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * 候補領域の抽出。3 つの抽出器（差分 / Optical Flow / 複合）への入口。
 *
 * <p>Swing 版 {@code methods/FrameSubtractionMethod}・{@code OpticalFlowMethod}・
 * {@code CompositeMethod} をまとめたもの（{@code fw/analysis-pipeline.md} §3）。
 *
 * <p>フレームの組 {@code (i, i+stride)} を受け取り、k 個の代表 ROI を返す。
 * <b>最終フレームでは相手が空画像</b>になる（Swing と同じ）。
 */
public final class CandidateExtractor {

    private CandidateExtractor() {
    }

    /**
     * @param current   フレーム {@code i}
     * @param ahead     フレーム {@code min(i+stride, N)}。{@code null} なら空画像として扱う
     * @param extractor 抽出器
     * @param k         クラスタ数
     * @param roi       ROI 生成・クラスタリングの定数
     * @param flowSet   Farnebäck のパラメータ
     * @return クラスタ番号 → 代表 ROI
     */
    public static Map<Integer, Roi> extract(Frame current, Frame ahead,
                                            AnalysisSettings.Extractor extractor,
                                            int k, RoiSettings roi, FlowSettings flowSet) {
        int w = current.width();
        int h = current.height();

        List<Roi> boxes = BoxGenerator.randomBoxes(
                w, h, roi.boxCount(),
                roi.minWidth(), roi.maxWidth(), roi.minHeight(), roi.maxHeight(),
                new Random(roi.boxSeed()));

        RoiScorer scorer;
        RoiFeatureExtractor features;

        switch (extractor) {
            case EXTRACTOR_SUBTRACTION -> {
                FloatProcessor sub = subtraction(current, ahead);
                scorer = new SubtractionRoi.Scorer(sub, roi.blurSigma());
                features = new SubtractionRoi.FeatureExtractor(sub);
            }
            case EXTRACTOR_OPTICALFLOW -> {
                double[][][] flow = smoothedFlow(current, ahead, flowSet, roi.flowSmoothSigma());
                scorer = new OpticalFlowRoi.Scorer(flow);
                features = new OpticalFlowRoi.FeatureExtractor(flow);
            }
            case EXTRACTOR_COMPOSITE -> {
                FloatProcessor sub = subtraction(current, ahead);
                double[][][] flow = smoothedFlow(current, ahead, flowSet, roi.flowSmoothSigma());
                SubtractionRoi.FeatureExtractor subFeatures = new SubtractionRoi.FeatureExtractor(sub);
                OpticalFlowRoi.FeatureExtractor flowFeatures = new OpticalFlowRoi.FeatureExtractor(flow);
                scorer = new CompositeRoi.Scorer(
                        new SubtractionRoi.Scorer(sub, roi.blurSigma()),
                        new OpticalFlowRoi.Scorer(flow));
                features = new CompositeRoi.FeatureExtractor(subFeatures, flowFeatures);
            }
            default -> throw new IllegalArgumentException("未知の抽出器: " + extractor);
        }

        return new RoiClusterPipeline(roi.clusterSeed()).run(
                boxes, scorer, features,
                roi.percentile(), Math.max(1, k), roi.maxIterations(), roi.normalize());
    }

    /**
     * 差分画像（{@code ahead - current}、符号付き）。
     *
     * <p>グレースケール化は ImageJ {@code convertToFloat()} と同じ<b>丸めなし</b>。
     */
    public static FloatProcessor subtraction(Frame current, Frame ahead) {
        int n = current.pixelCount();
        float[] sub = new float[n];
        if (ahead == null) {
            // 最終フレーム: 相手は空画像 → 差分は -current
            for (int i = 0; i < n; i++) {
                sub[i] = -current.grayFloat(i);
            }
        } else {
            for (int i = 0; i < n; i++) {
                sub[i] = ahead.grayFloat(i) - current.grayFloat(i);
            }
        }
        return new FloatProcessor(current.width(), current.height(), sub);
    }

    /** 平滑化済みフロー場。 */
    public static double[][][] smoothedFlow(Frame current, Frame ahead,
                                            FlowSettings settings, double smoothSigma) {
        int w = current.width();
        int h = current.height();
        float[] gray1 = grayFloats(current);
        float[] gray2 = ahead != null ? grayFloats(ahead) : new float[w * h];

        double[][][] flow = new Farneback().calcOpticalFlowFarneback(
                gray1, gray2, w, h,
                settings.pyrScale(), settings.levels(), settings.winSize(),
                settings.iterations(), settings.polyN(), settings.polySigma());

        return FlowSmoother.gaussian(flow, smoothSigma);
    }

    private static float[] grayFloats(Frame frame) {
        int n = frame.pixelCount();
        float[] gray = new float[n];
        for (int i = 0; i < n; i++) {
            gray[i] = frame.grayFloat(i);
        }
        return gray;
    }
}
