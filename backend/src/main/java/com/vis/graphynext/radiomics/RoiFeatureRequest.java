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
        java.util.Set<RoiMode> roiModes) {

    public enum RoiMode { WHOLE_3D, MAX_SECTION_2D, SLICES_2D }

    /** 単位を指定しない（3D だけ）。 */
    public RoiFeatureRequest(String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                             int maskChannel, int channel, int timePoint, Map<String, String> settings,
                             boolean recompute) {
        this(studyInstanceUid, sourceSeriesUid, maskSeriesUid, maskChannel, channel, timePoint, settings,
                recompute, null);
    }

    public boolean has(RoiMode mode) {
        return roiModes != null && roiModes.contains(mode);
    }
}
