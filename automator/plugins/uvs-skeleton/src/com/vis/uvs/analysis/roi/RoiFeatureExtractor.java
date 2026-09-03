package com.vis.uvs.analysis.roi;

import ij.gui.Roi;

import java.awt.Point;
import java.awt.Rectangle;

/**
 * ROI からクラスタリング用の特徴ベクトルを取り出す。
 *
 * <p>抽出できない（NaN / Inf を含む）場合は {@code null} を返す。呼び出し側は捨てる。
 */
public interface RoiFeatureExtractor {

    RoiFeatureVector extract(Roi roi);

    /**
     * ROI の中心。
     *
     * <p>Swing 版 {@code FeatureVectorExtractor.getCenter} と同じ整数演算。
     * {@code x + (int)(width/2)} であって四捨五入ではない。
     */
    default Point center(Roi roi) {
        Rectangle b = roi.getBounds();
        return new Point(b.x + (int) (b.width / 2), b.y + (int) (b.height / 2));
    }
}
