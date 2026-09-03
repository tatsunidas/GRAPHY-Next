package com.vis.uvs.analysis;

/**
 * 解析設定。既定値は Swing 版 {@code utils/Config} と一致させる
 * （{@code fw/analysis-pipeline.md} §9 が正本）。
 *
 * <p>Swing でハードコードされていた乱数シード・サンプル数・ROI パラメータも
 * ここへ外出しし、再現性を設定として明示する。
 *
 * @param colorThreshold          RGB の max-min がこの値を超えたら「色付きピクセル」
 * @param colorPixelRatioThreshold 色付きピクセル比率がこれを超えたらカラーフレーム
 * @param staticMeanAbsDiffThreshold 隣接フレーム平均絶対差がこれ未満なら静止フレーム
 * @param frameStrideInSeconds    差分 / Optical Flow の比較先までの秒数
 * @param predictionSamplingInterval 何フレームおきに推論するか
 * @param predictionCluster       ROI の k-means クラスタ数 k
 * @param predictionThreshold     この確率を超えたフレームを「心臓」とする
 * @param extractor               候補領域の抽出器
 * @param samplingPoints          色 / 静止判定のサンプリング点数
 * @param randomSeed              サンプリングの乱数シード
 */
public record AnalysisSettings(
        float colorThreshold,
        float colorPixelRatioThreshold,
        float staticMeanAbsDiffThreshold,
        float frameStrideInSeconds,
        int predictionSamplingInterval,
        int predictionCluster,
        float predictionThreshold,
        Extractor extractor,
        int samplingPoints,
        long randomSeed) {

    /** 候補領域の抽出器（Swing の {@code CandidateExtractorName}）。 */
    public enum Extractor {
        EXTRACTOR_SUBTRACTION,
        EXTRACTOR_OPTICALFLOW,
        EXTRACTOR_COMPOSITE
    }

    // --- Swing 版 utils/Config の既定値 ---
    public static final float DEFAULT_COLOR_THRESHOLD = 30f;
    public static final float DEFAULT_COLOR_PIX_RATIO = 0.0035f;
    public static final float DEFAULT_MEAN_ABS_DIFF = 0.5f;
    public static final float DEFAULT_FRAME_STRIDE_SEC = 0.2f;
    public static final int DEFAULT_PREDICTION_CLUSTER = 1;
    public static final float DEFAULT_PREDICTION_THRESHOLD = 0.75f;
    public static final int DEFAULT_SAMPLING_POINTS = 300;
    public static final long DEFAULT_RANDOM_SEED = 76L;

    /**
     * 既定値。
     *
     * <p>⚠ {@code predictionSamplingInterval} だけは Swing の 1000 を採らない。
     * 通常のクリップではフレーム 1 しか推論されず補間結果が定数になるため
     * （{@code fw/swing-feature-inventory.md} §7 B9）。fps から導く。
     *
     * @param fps 動画のフレームレート
     */
    public static AnalysisSettings defaults(double fps) {
        int interval = Math.max(1, (int) Math.round((fps > 0 ? fps : 30.0) * 0.5));
        return new AnalysisSettings(
                DEFAULT_COLOR_THRESHOLD,
                DEFAULT_COLOR_PIX_RATIO,
                DEFAULT_MEAN_ABS_DIFF,
                DEFAULT_FRAME_STRIDE_SEC,
                interval,
                DEFAULT_PREDICTION_CLUSTER,
                DEFAULT_PREDICTION_THRESHOLD,
                Extractor.EXTRACTOR_COMPOSITE,
                DEFAULT_SAMPLING_POINTS,
                DEFAULT_RANDOM_SEED);
    }

    /** 閾値だけを差し替える（スコアの再計算が不要な変更）。 */
    public AnalysisSettings withThresholds(float color, float colorRatio, float staticMad, float prediction) {
        return new AnalysisSettings(color, colorRatio, staticMad, frameStrideInSeconds,
                predictionSamplingInterval, predictionCluster, prediction,
                extractor, samplingPoints, randomSeed);
    }
}
