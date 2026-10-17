/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.time.Instant;
import java.util.List;

/**
 * ROI 特徴量表（1 ROI ぶん）。行の並びは RadiomicsJ の結果表の列の並びのまま。
 *
 * @param computedAt     RadiomicsJ で計算した時刻（キャッシュから返したときも計算した時刻）
 * @param fromCache      キャッシュから返したか
 * @param label          マスクのラベル値
 * @param discretisation 抽出のときに効いていた離散化
 */
public record RoiFeatureResult(
        String radiomicsjVersion,
        Instant computedAt,
        boolean fromCache,
        int label,
        List<Row> rows,
        Discretisation discretisation) {

    /**
     * @param column  RadiomicsJ の列名（例 {@code IntensityBasedStatistical_Kurtosis}）
     * @param ibsi    IBSI コード。IBSI 外なら null
     * @param value   値。RadiomicsJ が NaN を返したら null（0 にしない）
     * @param notes   定義の注記の符号（{@link RoiFeatureDefinitions} の NOTE_*）
     */
    public record Row(String column, String family, String feature, String ibsi, Double value, List<String> notes) {}

    /** テクスチャ族と離散化ヒストグラムは同じ離散化画像を使う。IVH は別の設定。 */
    public record Discretisation(boolean fixedBinNumber, int nBins, double binWidth,
                                 int ivhMode, int ivhBinCount, double ivhBinWidth) {}

    RoiFeatureResult asCached() {
        return new RoiFeatureResult(radiomicsjVersion, computedAt, true, label, rows, discretisation);
    }
}
