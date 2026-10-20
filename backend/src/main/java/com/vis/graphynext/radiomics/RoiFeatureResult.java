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
 * @param provenance     版と設定の記録（CSV の Provenance_* 列）
 * @param settingsProperties 計算に実際に使った設定を正規化した RadiomicsJ の {@code .properties} 本文
 *                       （{@link RadiomicsJSettingsSnapshot}）。{@code provenance.settingsSha256} はこの UTF-8 の SHA-256
 * @param roiSize        ROI の大きさと小さい ROI の警告。返すたびに行と今の環境設定から付け直す（キャッシュの値は使わない）
 * @param lossyCompressed 元画像が非可逆圧縮（特徴量は圧縮の影響を受ける）。返すたびに読み込んだ画像から付ける
 */
public record RoiFeatureResult(
        String radiomicsjVersion,
        Instant computedAt,
        boolean fromCache,
        int label,
        List<Row> rows,
        Discretisation discretisation,
        Provenance provenance,
        String settingsProperties,
        RoiSize roiSize,
        boolean lossyCompressed) {

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

    /**
     * @param graphyNextVersion 計算した GRAPHY-Next の版（{@code graphy.version}、開発中は dev）
     * @param radiomicsjVersion {@code RadiomicsJ.version}
     * @param extractedAt       抽出した時刻（キャッシュから返しても最初に計算した時刻）
     * @param settingsSha256    {@code settingsProperties} の SHA-256（16 進小文字）
     */
    public record Provenance(String graphyNextVersion, String radiomicsjVersion, Instant extractedAt,
                             String settingsSha256) {}

    /**
     * ボクセル数は RadiomicsJ の Diagnostics の値。
     *
     * @param initialVoxels      読み込んだマスクのボクセル数（リサンプリング・再セグメントの前）
     * @param intensityVoxels    強度・テクスチャ特徴を計算したボクセル数（リサンプリング・範囲フィルタ・外れ値除去の後）
     * @param morphVoxels        形態特徴のマスク（リサンプリング後・再セグメントしない）のボクセル数
     * @param volumeMm3          {@code morphVoxels} × 計算格子のボクセル体積
     * @param smallRoiWarnVoxels 環境設定の基準値。未設定なら null
     * @param smallRoi           {@code intensityVoxels < smallRoiWarnVoxels}。基準値が未設定なら null
     */
    public record RoiSize(Long initialVoxels, Long intensityVoxels, Long morphVoxels, Double volumeMm3,
                          Integer smallRoiWarnVoxels, Boolean smallRoi) {}

    RoiFeatureResult asCached() {
        return new RoiFeatureResult(radiomicsjVersion, computedAt, true, label, rows, discretisation,
                provenance, settingsProperties, roiSize, lossyCompressed);
    }

    /** 返すたびに付け直す欄（キャッシュに無い・古いかもしれない値）。 */
    RoiFeatureResult withPerRequest(RoiSize size, boolean lossy) {
        return new RoiFeatureResult(radiomicsjVersion, computedAt, fromCache, label, rows, discretisation,
                provenance, settingsProperties, size, lossy);
    }
}
