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
 * @param scalesMm      LoG で強調する構造の半径 r（mm）の並び。0 はフィルタなし。null か空はスケールなし（従来）。
 *                      設定の {@code DOUBLEARRAY_logSigmaMm} とは併用できない（切り捨て・境界は設定のものを全スケールに使う）
 * @param scaleConversion r → σ の換算（{@code SQRT_D}〔既定〕・{@code IDENTITY}・{@code COEFFICIENT}）
 * @param scaleCoefficient {@code COEFFICIENT} の k（σ = k·r）
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
        java.util.List<Double> scalesMm,
        String scaleConversion,
        Double scaleCoefficient) {

    /** スケールを指定しない（従来の要求）。 */
    public RoiFeatureRequest(String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                             int maskChannel, int channel, int timePoint, Map<String, String> settings,
                             boolean recompute, java.util.Set<RoiMode> roiModes) {
        this(studyInstanceUid, sourceSeriesUid, maskSeriesUid, maskChannel, channel, timePoint, settings,
                recompute, roiModes, null, null, null);
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
        return scalesMm != null && !scalesMm.isEmpty();
    }

    public boolean has(RoiMode mode) {
        return roiModes != null && roiModes.contains(mode);
    }
}
