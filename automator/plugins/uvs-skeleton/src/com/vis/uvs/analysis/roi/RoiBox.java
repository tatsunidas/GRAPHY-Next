package com.vis.uvs.analysis.roi;

import ij.gui.Roi;

/**
 * API 境界で ROI を表す値（ImageJ の {@code Roi} をフロントへ漏らさないため）。
 *
 * @param clusterId クラスタ番号（クラスタリング結果の場合）
 * @param x 左上 X（整数 bounds）
 * @param y 左上 Y
 * @param width 幅
 * @param height 高さ
 * @param score スコア（未評価なら {@code null}）
 */
public record RoiBox(Integer clusterId, int x, int y, int width, int height, Double score) {

    public static RoiBox of(Roi roi, Integer clusterId, Double score) {
        java.awt.Rectangle b = roi.getBounds();
        return new RoiBox(clusterId, b.x, b.y, b.width, b.height, score);
    }

    public Roi toRoi() {
        return new Roi(x, y, width, height);
    }
}
