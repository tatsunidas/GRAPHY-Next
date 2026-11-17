/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.util.Map;

/**
 * ROI 特徴量表の要求。
 *
 * @param maskSeriesUid ROI マスクシリーズ（必須）
 * @param maskChannel   SEG のセグメント（マスクの C 次元）
 * @param channel       画像スタックの C
 * @param timePoint     画像スタックの T
 * @param settings      RadiomicsJ の設定キーそのまま（{@code INT_binCount}・{@code BOOL_enableGLCM} など）。
 *                      Next のテクスチャ設定とは混ぜない
 * @param recompute     キャッシュを使わずに計算し、結果でキャッシュを置き換える
 * @param roiModes      計算の単位（{@code WHOLE_3D}・{@code MAX_SECTION_2D}・{@code SLICES_2D}）。
 *                      null か空は {@code WHOLE_3D} だけ（従来の要求と同じ）。{@code WHOLE_3D} は常に計算する
 * @param scales        LoG のスケールの値の並び（単位は {@code scaleNotation}）。0 はフィルタなし。
 *                      null か空はスケールなし（従来）。設定の {@code DOUBLEARRAY_logSigmaMm} とは併用できない
 *                      （切り捨て・境界は設定のものを全スケールに使う）
 * @param scaleNotation {@code scales} の書き方。{@code RADIUS_MM}（強調する構造の半径 r、mm〔既定〕）か
 *                      {@code WIDTH_PX}（構造の直径の画素数。r ＝ 幅 × 元の面内の画素間隔 / 2）
 * @param scaleLabels   各スケールの名札（旧フィルタ値など。記録するだけで計算には使わない）。null か空は名札なし、
 *                      あれば {@code scales} と同じ数
 * @param scaleConversion r → σ の換算（{@code SQRT_D}〔既定〕・{@code IDENTITY}・{@code COEFFICIENT}）
 * @param scaleCoefficient {@code COEFFICIENT} の k（σ = k·r）
 * @param smallRoiWarnVoxels 小さい ROI の基準値（ボクセル数、3D）。null は環境設定の値を使う。計算結果のキャッシュには
 *                      影響しない（基準値は読み出しのときに適用する）
 * @param calibration   PET の校正。null・{@code auto} は PET（Units が BQML・CNTS）を SUVbw に校正し、CT・MR などは何もしない。
 *                      {@code bw}・{@code sul-james}・{@code sul-janma}・{@code bsa} は PET をその SUV に校正（PET 以外は断る）。
 *                      {@code none} は PET を Bq/mL のまま（利用者が明示したときだけ。結果に旗を付ける）。
 *                      校正後の画素値で離散化・範囲・特徴量を計算するので、キャッシュの鍵も変わる
 */
public record RoiFeatureRequest(
        String studyInstanceUid,
        String sourceSeriesUid,
        String maskSeriesUid,
        int maskChannel,
        int channel,
        int timePoint,
        Map<String, String> settings,
        boolean recompute,
        java.util.Set<RoiMode> roiModes,
        java.util.List<Double> scales,
        String scaleNotation,
        java.util.List<String> scaleLabels,
        String scaleConversion,
        Double scaleCoefficient,
        Integer smallRoiWarnVoxels,
        String calibration) {

    /** PET の校正の指定（{@code calibration}）の値。null は {@link #CALIBRATION_AUTO}。 */
    public static final String CALIBRATION_AUTO = "auto";
    public static final String CALIBRATION_NONE = "none";
    public static final java.util.Set<String> CALIBRATIONS = java.util.Set.of(
            CALIBRATION_AUTO, CALIBRATION_NONE, "bw", "sul-james", "sul-janma", "bsa");

    /** 校正の指定なし（従来の要求。{@code auto}）。 */
    public RoiFeatureRequest(String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                             int maskChannel, int channel, int timePoint, Map<String, String> settings,
                             boolean recompute, java.util.Set<RoiMode> roiModes, java.util.List<Double> scales,
                             String scaleNotation, java.util.List<String> scaleLabels, String scaleConversion,
                             Double scaleCoefficient, Integer smallRoiWarnVoxels) {
        this(studyInstanceUid, sourceSeriesUid, maskSeriesUid, maskChannel, channel, timePoint, settings,
                recompute, roiModes, scales, scaleNotation, scaleLabels, scaleConversion, scaleCoefficient,
                smallRoiWarnVoxels, null);
    }

    /** 読み込みに渡す校正の指定。null・空は {@code auto}。 */
    public String calibrationOrAuto() {
        return calibration == null || calibration.isBlank() ? CALIBRATION_AUTO : calibration.trim().toLowerCase();
    }

    /** スケールを指定しない（従来の要求）。 */
    public RoiFeatureRequest(String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                             int maskChannel, int channel, int timePoint, Map<String, String> settings,
                             boolean recompute, java.util.Set<RoiMode> roiModes) {
        this(studyInstanceUid, sourceSeriesUid, maskSeriesUid, maskChannel, channel, timePoint, settings,
                recompute, roiModes, null, null, null, null, null, null, null);
    }

    public enum RoiMode { WHOLE_3D, MAX_SECTION_2D, SLICES_2D }

    /** 単位を指定しない（3D だけ）。 */
    public RoiFeatureRequest(String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                             int maskChannel, int channel, int timePoint, Map<String, String> settings,
                             boolean recompute) {
        this(studyInstanceUid, sourceSeriesUid, maskSeriesUid, maskChannel, channel, timePoint, settings,
                recompute, null);
    }

    public boolean hasScales() {
        return scales != null && !scales.isEmpty();
    }

    public boolean has(RoiMode mode) {
        return roiModes != null && roiModes.contains(mode);
    }
}
