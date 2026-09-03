package com.vis.uvs.analysis.candidate;

import com.vis.uvs.analysis.roi.BoxGenerator;
import com.vis.uvs.analysis.roi.RoiClusterPipeline;
import com.vis.uvs.analysis.roi.RoiSettings;
import com.vis.uvs.analysis.roi.SubtractionRoi;
import com.vis.uvs.video.Frame;
import ij.gui.Roi;
import ij.process.FloatProcessor;

import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * フレーム差分による候補領域抽出。
 *
 * <p>Swing 版 {@code methods/FrameSubtractionMethod} の移植
 * （{@code fw/analysis-pipeline.md} §3.1・§3.4〜§4）。
 *
 * <p>超音波の胸部では「明るいものが動く」ので、時間差分の絶対値が大きい領域を候補とする。
 */
public final class SubtractionCandidateExtractor {

    private SubtractionCandidateExtractor() {
    }

    /**
     * 差分画像を作る。
     *
     * <p><b>符号付き</b>（{@code ahead - current}）。abs はスコアリング側で取る。
     * グレースケール化は ImageJ の {@code convertToFloat()} と同じ<b>丸めなし</b>の
     * 非加重平均（{@link Frame#grayFloat(int)}）。
     *
     * @param current フレーム {@code i}
     * @param ahead   フレーム {@code min(i + stride, N)}。{@code i == N} のときは呼ばない
     */
    public static FloatProcessor subtraction(Frame current, Frame ahead) {
        int n = current.pixelCount();
        float[] sub = new float[n];
        for (int i = 0; i < n; i++) {
            sub[i] = ahead.grayFloat(i) - current.grayFloat(i);
        }
        return new FloatProcessor(current.width(), current.height(), sub);
    }

    /** 最終フレーム用の全 0 画像（Swing は末尾で blank と比較していた）。 */
    public static FloatProcessor blank(int width, int height) {
        return new FloatProcessor(width, height);
    }

    /**
     * 差分画像から候補 ROI を k 個抽出する。
     *
     * @param subtraction 差分画像
     * @param k           クラスタ数（1 以上）
     * @param settings    ROI 生成・クラスタリングの定数
     * @return クラスタ番号 → 代表 ROI
     */
    public static Map<Integer, Roi> extract(FloatProcessor subtraction, int k, RoiSettings settings) {
        int width = subtraction.getWidth();
        int height = subtraction.getHeight();

        List<Roi> boxes = BoxGenerator.randomBoxes(
                width, height, settings.boxCount(),
                settings.minWidth(), settings.maxWidth(),
                settings.minHeight(), settings.maxHeight(),
                new Random(settings.boxSeed()));

        SubtractionRoi.Scorer scorer = new SubtractionRoi.Scorer(subtraction, settings.blurSigma());
        SubtractionRoi.FeatureExtractor extractor = new SubtractionRoi.FeatureExtractor(subtraction);

        return new RoiClusterPipeline(settings.clusterSeed()).run(
                boxes, scorer, extractor,
                settings.percentile(), Math.max(1, k),
                settings.maxIterations(), settings.normalize());
    }
}
