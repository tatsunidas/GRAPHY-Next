/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.util.List;
import java.util.Map;

/**
 * GLAM 解析の結果。記述子そのものを返す。
 *
 * <p>特徴量 150 個は行列を要約した「答え」だが、解釈に効くのは<b>その手前</b>にある
 * 動径分布関数と親和性行列そのもの（原著論文の図が見せているのはこちら）。数値をそのまま返し、
 * 描画はフロントに任せる。
 *
 * @param featureCount    この設定で得られる特徴の数（参考値, 150）
 * @param nBins           離散化のビン数。行列は nBins×nBins
 * @param maxRadius       動径分布を評価した最大距離（ボクセル）
 * @param roiVoxelCount   ROI のボクセル数
 * @param binOccupancy    ビンごとのボクセル数。<b>稀なビンほど g(r) は跳ねる</b>ので、
 *                        曲線を読む前にこれを見る必要がある
 * @param radii           r の値（1..maxRadius）
 * @param selfAffinity    自己親和性 g(α,α,r)。{@code [α][r]}。<b>1.0 が「偶然と区別がつかない」水準</b>
 * @param selfAffinityRandom 同じ並びのランダム参照状態。境界補正が効いていれば 1.0 付近になる
 * @param matrices        親和性行列（19 種）。キーは {@code GLAMMatrixType} 名、値は nBins×nBins
 * @param diagonalOnly    自己ペアだけで定義される行列の名前（非対角は意味を持たない）
 * @param voxelSpacing    ボクセル間隔 (x,y,z) mm。等方でなければ距離の意味が歪む
 * @param isotropic       等方ボクセルか
 * @param settings        実際に使われた GLAM の設定（後から値の意味を辿れるように）
 */
public record GlamAnalysis(
        int featureCount,
        int nBins,
        int maxRadius,
        long roiVoxelCount,
        long[] binOccupancy,
        int[] radii,
        double[][] selfAffinity,
        double[][] selfAffinityRandom,
        Map<String, double[][]> matrices,
        List<String> diagonalOnly,
        double[] voxelSpacing,
        boolean isotropic,
        Map<String, String> settings) {
}
