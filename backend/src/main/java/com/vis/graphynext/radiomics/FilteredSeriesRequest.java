/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.util.List;

/**
 * フィルタ画像（LoG）を派生シリーズとして作る要求。画像全体に掛け、リサンプリングしない（元の格子のまま）。
 *
 * @param scales          スケールの値の並び（単位は {@code scaleNotation}）。0 はフィルタなしなので指定できない
 * @param scaleNotation   {@code RADIUS_MM}（強調する構造の半径 r、mm〔既定〕）か {@code WIDTH_PX}（構造の直径の画素数）
 * @param scaleConversion r → σ の換算（{@code SQRT_D}〔既定〕・{@code IDENTITY}・{@code COEFFICIENT}）
 * @param scaleCoefficient {@code COEFFICIENT} の k
 * @param dimension       {@code 2D}（面内、既定）か {@code 3D}。換算の d も決まる
 * @param truncate        核の切り捨て（σ の倍数、既定 4）
 * @param padding         境界（{@code MIRROR}〔既定〕・{@code NEAREST}・{@code CONSTANT}・{@code PERIODIC}）
 */
public record FilteredSeriesRequest(
        String studyInstanceUid,
        String sourceSeriesUid,
        int channel,
        int timePoint,
        List<Double> scales,
        String scaleNotation,
        String scaleConversion,
        Double scaleCoefficient,
        String dimension,
        Double truncate,
        String padding) {
}
