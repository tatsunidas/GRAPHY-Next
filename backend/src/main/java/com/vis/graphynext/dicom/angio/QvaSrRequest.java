/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

/**
 * QVA（末梢・脳血管）解析結果を DICOM SR として書き出す要求（{@code fw/angio-design.md} §9.1 / A5a）。
 *
 * <p>QCA（{@link QcaSrRequest}）と分けているのは、<b>瘤の指標と、瘤にだけ付く限界</b>
 * （1 方向の投影で測った最大径であること）が増えるため。QCA の SR に瘤の欄を混ぜると、
 * 冠動脈の SR に空の瘤欄が並ぶ。
 *
 * @param unit          "mm" または "px"（未校正なら px のまま書く。mm を騙らない）
 * @param calibration   校正の出自（人向け文字列）
 * @param manualCorrection 手修正の内容。全自動なら null（設計 §8.6）
 * @param dilation      拡張（瘤）。<b>拡張が無ければ null</b>。0 で埋めると「瘤 0mm」という
 *                      別の主張になる
 */
public record QvaSrRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String sopInstanceUid,
        Integer frameNumber,
        String unit,
        String calibration,
        String vesselLabel,
        String manualCorrection,
        double mld,
        double rvd,
        double percentDiameterStenosis,
        double lesionLength,
        Dilation dilation) {

    /**
     * 拡張（瘤）の計測。
     *
     * @param ratio        最大径 / 参照径。<b>半値法の系統誤差（約 13% 過小・§16.4）が
     *                     打ち消される量</b>なので、瘤かどうかの判定はこれで行う
     * @param eccentricity 0（全周性＝紡錘状）〜1（片側だけ＝嚢状）。測れなければ null
     * @param aneurysmal   参照径の 1.5 倍以上か。<b>基準そのものも SR の本文に書く</b>
     */
    public record Dilation(
            double maxDiameter,
            double ratio,
            double percentDilation,
            double length,
            double proximalNeck,
            double distalNeck,
            Double eccentricity,
            boolean aneurysmal) {
    }
}
