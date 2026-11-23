/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

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
 * @param margin             窓を切り出す前に ROI を広げるボクセル数（任意, null で RadiomicsJ 既定の 3）。
 *                           ROI 端のボクセルは窓が部分的にしか埋まらないため、テクスチャの違いではなく
 *                           「読んだ画素が少ない」という理由だけで値がずれる。それを埋めるための余白。
 *                           <b>0 で RadiomicsJ 2.3.0 以前の挙動</b>（{@code fw/texture-radiomics-design.md} §11.6）
 * @param seriesDescription  出力シリーズ説明（任意）
 * @param seriesNumber       出力シリーズ番号（任意, null で自動採番）
 * @param calibration        PET の校正の指定（{@link RoiFeatureRequest#CALIBRATIONS} の 6 値。null・空は {@code auto}＝
 *                           PET は SUVbw、CT・MR はそのまま）。読み込みで画素値に掛けるので、マップの値・離散化・
 *                           固定ビン幅は校正後の値に対して働く。{@link RadiomicsMapEngine#CALIBRATION_SETTING} として
 *                           読み込みにだけ渡し、RadiomicsJ の設定・途中結果の設定のキーには入れない
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
        Integer margin,
        String seriesDescription,
        Integer seriesNumber,
        String calibration) {

    /** 校正の指定なし（従来の要求。{@code auto}）。 */
    public TextureSeriesRequest(String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                                int maskChannel, String feature, int filterSize, int stride, boolean force2D,
                                int channel, int timePoint, Map<String, String> settings, Integer margin,
                                String seriesDescription, Integer seriesNumber) {
        this(studyInstanceUid, sourceSeriesUid, maskSeriesUid, maskChannel, feature, filterSize, stride, force2D,
                channel, timePoint, settings, margin, seriesDescription, seriesNumber, null);
    }

    /** 読み込みに渡す校正の指定。null・空は {@code auto}。 */
    public String calibrationOrAuto() {
        return calibrationOrAuto(calibration);
    }

    static String calibrationOrAuto(String calibration) {
        return calibration == null || calibration.isBlank()
                ? RoiFeatureRequest.CALIBRATION_AUTO : calibration.trim().toLowerCase(java.util.Locale.ROOT);
    }

    /** 不正な校正の指定を断る（未知の値は校正の解決で auto 扱いになってしまうので、読み込みの前に止める）。 */
    static void checkCalibration(String calibration) {
        if (!RoiFeatureRequest.CALIBRATIONS.contains(calibrationOrAuto(calibration))) {
            throw new IllegalArgumentException("calibration は auto・none・bw・sul-james・sul-janma・bsa のどれかです: "
                    + calibration);
        }
    }

    /** 読み込み（{@link RadiomicsMapEngine#load}）に渡す設定。呼び出し元の設定の写しに校正の指定だけを足す。 */
    static Map<String, String> loadSettings(Map<String, String> settings, String calibration) {
        Map<String, String> out = new java.util.HashMap<>();
        if (settings != null) out.putAll(settings);
        out.put(RadiomicsMapEngine.CALIBRATION_SETTING, calibrationOrAuto(calibration));
        return out;
    }
}
