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
 */
public record RoiFeatureRequest(
        String studyInstanceUid,
        String sourceSeriesUid,
        String maskSeriesUid,
        int maskChannel,
        int channel,
        int timePoint,
        Map<String, String> settings,
        boolean recompute) {}
