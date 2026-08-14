/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

/**
 * QCA 解析結果を DICOM SR として書き出す要求（{@code fw/angio-design.md} §14.2 / A10）。
 *
 * @param frameNumber   解析したフレーム（**1 origin**）。単一フレーム画像なら null
 * @param unit          "mm" または "px"（未校正なら px のまま書く。mm を騙らない）
 * @param calibration   校正の出自（"カテーテル 6Fr / 0.208 mm/px" のような人向け文字列）。
 *                      <b>数値だけ保存して出自を落とさない</b>ためのフィールド
 * @param vesselLabel   血管・区間の名前（任意）
 */
public record QcaSrRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String sopInstanceUid,
        Integer frameNumber,
        String unit,
        String calibration,
        String vesselLabel,
        double mld,
        double rvd,
        double percentDiameterStenosis,
        double percentAreaStenosis,
        double lesionLength) {
}
