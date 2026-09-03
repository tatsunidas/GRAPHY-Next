package com.vis.uvs.analysis.roi;

import ij.gui.Roi;

/**
 * ROI 候補のスコアリング。値の大きい ROI が「動きのある領域」。
 *
 * <p>実装は {@code fw/analysis-pipeline.md} §3.5 が正本。
 */
@FunctionalInterface
public interface RoiScorer {
    double score(Roi roi);
}
