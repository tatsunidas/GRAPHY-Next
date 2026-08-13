/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.util.Map;

/**
 * GLAM 解析（ROI 全体を 1 つの領域として見る）の要求。
 *
 * <p>可視化マップと違い <b>カーネルが無い</b>。マップは窓ごとに GLAM を回すので、窓の外は見えず
 * maxRadius がカーネル半径で頭打ちになる（kernel 7 なら r=1..3）。GLAM の売りである
 * 「数〜数十ボクセルの長距離構造」はそこでほぼ落ちる。こちらは ROI 全体で 1 回だけ回すため、
 * maxRadius を 30〜50 と実用的な距離まで取れる。両者は競合ではなく補完の関係にある。
 *
 * @param studyInstanceUid  対象 Study
 * @param sourceSeriesUid   解析対象シリーズ
 * @param maskSeriesUid     ROI マスクシリーズ（<b>必須</b>。全面では意味のある動径分布にならない）
 * @param maskChannel       マスクの C インデックス（DICOM SEG マルチセグメント時の選択, 既定 0）
 * @param channel           マルチ次元スタックの C インデックス（既定 0）
 * @param timePoint         マルチ次元スタックの T インデックス（既定 0）
 * @param maxRadius         動径分布を見る最大距離（ボクセル, 既定 30）
 * @param settings          Radiomics パラメータ（GRAPHY Property キー→値。ビン設定と GLAM 各種）
 */
public record GlamAnalysisRequest(
        String studyInstanceUid,
        String sourceSeriesUid,
        String maskSeriesUid,
        int maskChannel,
        int channel,
        int timePoint,
        Integer maxRadius,
        Map<String, String> settings) {
}
