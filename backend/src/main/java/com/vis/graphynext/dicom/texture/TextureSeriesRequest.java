/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.texture;

import java.util.Map;

/**
 * Texture（Radiomics 可視化マップ）生成リクエスト。
 *
 * <p>ターゲットシリーズ（＋任意のマスクシリーズ）から 1 特徴の voxel-wise マップを計算し、
 * 派生セカンダリシリーズ（16bit unsigned + Rescale で 32bit float を保持）として DB 保存する。
 * 設計 {@code fw/texture-radiomics-design.md}。
 *
 * @param studyInstanceUid   対象 Study
 * @param sourceSeriesUid    ターゲット（計算元）シリーズ
 * @param maskSeriesUid      マスクシリーズ（任意, null/空なら全面マスク）
 * @param maskChannel        マスクの C インデックス（DICOM SEG がマルチセグメント=マルチ C の場合の選択, 既定 0）
 * @param feature            {@code "<FAMILY>_<FeatureName>"}（例 "GLCM_JointEntropy"）
 * @param filterSize         カーネル径（奇数推奨, 3〜99）
 * @param stride             x,y,z 共通のストライド（1=等倍。&gt;1 は間引き→Trilinear 拡大）
 * @param force2D            true=2D(XY) パッチ, false=3D(XYZ) パッチ
 * @param channel            マルチ次元スタックの C インデックス（既定 0）
 * @param timePoint          マルチ次元スタックの T インデックス（既定 0）
 * @param settings           Radiomics パラメータ（GRAPHY Property キー→値の文字列マップ。
 *                           例 "MASK_LABEL_INT"=1, "BINCOUNT_GLCM_INT"=16, "DELTA_GLCM_DOUBLE"=1）
 * @param seriesDescription  出力シリーズ説明（任意）
 * @param seriesNumber       出力シリーズ番号（任意, null で自動採番）
 */
public record TextureSeriesRequest(
        String studyInstanceUid,
        String sourceSeriesUid,
        String maskSeriesUid,
        int maskChannel,
        String feature,
        int filterSize,
        int stride,
        boolean force2D,
        int channel,
        int timePoint,
        Map<String, String> settings,
        String seriesDescription,
        Integer seriesNumber) {
}
