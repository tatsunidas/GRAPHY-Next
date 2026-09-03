package com.vis.uvs.analysis.roi;

import com.vis.uvs.analysis.AnalysisSettings;

/**
 * ROI 候補生成・クラスタリングの定数。
 *
 * <p>Swing 版では抽出器ごとに<b>ハードコード</b>されており、しかも Composite だけ
 * 個数とシードが違った。挙動を変えないためその差もそのまま持ち込み、設定として外出しする
 * （{@code fw/analysis-pipeline.md} §3.4・§4）。
 *
 * @param boxCount      候補ボックス数
 * @param boxSeed       ボックス生成の乱数シード
 * @param minWidth      ボックス最小幅
 * @param maxWidth      ボックス最大幅
 * @param minHeight     ボックス最小高さ
 * @param maxHeight     ボックス最大高さ
 * @param percentile    足切りのパーセンタイル
 * @param maxIterations k-means の最大反復
 * @param normalize     特徴を min-max 正規化するか
 * @param clusterSeed   k-means の乱数シード
 * @param blurSigma     差分スコアリングの Gaussian σ
 * @param flowSmoothSigma Optical Flow 平滑化の Gaussian σ
 */
public record RoiSettings(
        int boxCount,
        long boxSeed,
        double minWidth,
        double maxWidth,
        double minHeight,
        double maxHeight,
        double percentile,
        int maxIterations,
        boolean normalize,
        long clusterSeed,
        double blurSigma,
        double flowSmoothSigma) {

    /**
     * Swing 版の既定値。
     *
     * <p>⚠ <b>Composite だけボックス数 300 / シード 76</b>（他は 150 / 123）。
     * 意図的かは不明だが、挙動を変えないため維持する。
     */
    public static RoiSettings forExtractor(AnalysisSettings.Extractor extractor) {
        boolean composite = extractor == AnalysisSettings.Extractor.EXTRACTOR_COMPOSITE;
        return new RoiSettings(
                composite ? 300 : 150,
                composite ? 76L : 123L,
                100, 200, 100, 200,
                80.0,
                100,
                true,
                76L,
                3.0,
                5.0);
    }
}
