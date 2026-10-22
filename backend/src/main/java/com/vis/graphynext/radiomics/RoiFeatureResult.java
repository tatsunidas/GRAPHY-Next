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
 * @param section        最大断面 2D の結果。単位に {@code MAX_SECTION_2D} を選んだときだけ入る
 * @param slices         スライス別 2D の結果。単位に {@code SLICES_2D} を選んだときだけ入る
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
        boolean lossyCompressed,
        Section section,
        Slices slices,
        List<ScaleEntry> scales) {

    /** 3D と 2D の単位まで（スケールなし）。 */
    public RoiFeatureResult(String radiomicsjVersion, Instant computedAt, boolean fromCache, int label,
                            List<Row> rows, Discretisation discretisation, Provenance provenance,
                            String settingsProperties, RoiSize roiSize, boolean lossyCompressed,
                            Section section, Slices slices) {
        this(radiomicsjVersion, computedAt, fromCache, label, rows, discretisation, provenance,
                settingsProperties, roiSize, lossyCompressed, section, slices, null);
    }

    /**
     * 空間スケール 1 つぶんの結果。{@code sigma3dMm}（3D の単位）・{@code sigma2dMm}（2D の単位）は換算後の σ で、
     * r=0（フィルタなし）なら null。{@code scaleMm} は換算後の半径 r。{@code inputNotation}（{@code radius_mm}・
     * {@code width_px}）・{@code inputValue} は指定された書き方と値、{@code pixelSpacingMm} は幅（画素）を r に直した
     * 画素間隔（幅のときだけ）、{@code legacyLabel} は名札（無ければ null）。{@code result} は通常の結果
     * （入れ子には {@code scales} が無い）。
     */
    public record ScaleEntry(double scaleMm, Double sigma3dMm, Double sigma2dMm, String conversion,
                             Double coefficient, String inputNotation, double inputValue, Double pixelSpacingMm,
                             String legacyLabel, RoiFeatureResult result) {}

    /** 3D だけの結果（2D の単位を選ばなかったとき）。 */
    public RoiFeatureResult(String radiomicsjVersion, Instant computedAt, boolean fromCache, int label,
                            List<Row> rows, Discretisation discretisation, Provenance provenance,
                            String settingsProperties, RoiSize roiSize, boolean lossyCompressed) {
        this(radiomicsjVersion, computedAt, fromCache, label, rows, discretisation, provenance,
                settingsProperties, roiSize, lossyCompressed, null, null);
    }

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

    /**
     * 2D の計算の記録（実際に使った設定 {@code BOOL_force2D=1} を含む）。3D と設定が違うのでハッシュも別。
     */
    public record Record2d(Instant computedAt, Discretisation discretisation, Provenance provenance,
                           String settingsProperties) {}

    /**
     * 最大断面 2D（{@link MaxSectionService} が選んだ 1 枚）。
     *
     * @param positionMm 患者座標の法線方向の位置（mm）。スライス番号は持たない
     */
    public record Section(boolean fromCache, double positionMm, double areaMm2, long pixels, List<Row> rows,
                          Record2d record, RoiSize roiSize) {}

    /** スライス 1 枚ぶんの行（前景のあるスライスだけ）。 */
    public record SliceRow(double positionMm, long pixels, double areaMm2, List<Row> rows) {}

    /** 抽出に失敗したスライス（黙って飛ばさず、位置と理由を持つ）。 */
    public record SliceFailure(double positionMm, String reason) {}

    /**
     * スライス別 2D。
     *
     * @param rows               値のあるスライス（位置の昇順）
     * @param failures           失敗したスライス
     * @param mean               列ごとの単純平均（値のあるスライスだけ）
     * @param pixelWeightedMean  列ごとの強度マスク画素数の重み付き平均
     * @param slicesUsed         列ごとに集約に使ったスライス数
     * @param foregroundSlices   前景のあるスライス数（rows＋failures）
     */
    public record Slices(boolean fromCache, List<SliceRow> rows, List<SliceFailure> failures, List<Row> mean,
                         List<Row> pixelWeightedMean, java.util.Map<String, Integer> slicesUsed,
                         int foregroundSlices, Record2d record, Integer smallRoiWarnPixels,
                         List<Double> smallRoiPositionsMm) {}

    RoiFeatureResult asCached() {
        return new RoiFeatureResult(radiomicsjVersion, computedAt, true, label, rows, discretisation,
                provenance, settingsProperties, roiSize, lossyCompressed, section, slices, scales);
    }

    RoiFeatureResult withScales(List<ScaleEntry> list) {
        return new RoiFeatureResult(radiomicsjVersion, computedAt, fromCache, label, rows, discretisation,
                provenance, settingsProperties, roiSize, lossyCompressed, section, slices, list);
    }

    RoiFeatureResult withModes(Section sec, Slices sl) {
        return new RoiFeatureResult(radiomicsjVersion, computedAt, fromCache, label, rows, discretisation,
                provenance, settingsProperties, roiSize, lossyCompressed, sec, sl, scales);
    }

    /** 返すたびに付け直す欄（キャッシュに無い・古いかもしれない値）。 */
    RoiFeatureResult withPerRequest(RoiSize size, boolean lossy) {
        return new RoiFeatureResult(radiomicsjVersion, computedAt, fromCache, label, rows, discretisation,
                provenance, settingsProperties, size, lossy, section, slices, scales);
    }
}
