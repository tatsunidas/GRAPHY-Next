/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

/**
 * QLV（左室造影）解析結果を DICOM SR として書き出す要求（{@code fw/angio-design.md} §9.2 / A5b）。
 *
 * @param edFrameNumber  拡張末期フレーム（<b>1 origin</b>）
 * @param esFrameNumber  収縮末期フレーム（<b>1 origin</b>）
 * @param unit           容積の単位。<b>校正済みなら "mL"、未校正なら null</b>。
 *                       未校正でも EF は正しい（スケール不変）が、<b>容積は出せない</b>ので
 *                       null を渡す。px³ を mL と偽らないための区別（§9.2.1）
 * @param calibration    校正の出自（人向け文字列）。null なら未校正
 * @param frameSelection ED/ES をどう決めたか（"manual" / "automatic (area curve)"）。
 *                       <b>造影剤注入で心室期外収縮は普通に起き、その直後の心拍は EF を
 *                       過大評価する</b>。ECG が無い本経路では検出できないので、
 *                       自動提案のままか人が選んだかは<b>結果の意味を変える</b>（§9.2.2）
 * @param edvMl          校正済みのときだけ。未校正なら null
 * @param esvMl          同上
 * @param kennedyEdvMl   Kennedy 回帰補正後。<b>未校正では必ず null</b>
 *                       （補正はアフィン変換でスケール不変ではないため）
 * @param method         解析手法（"Area-Length (single plane)"）
 */
public record QlvSrRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String sopInstanceUid,
        Integer edFrameNumber,
        Integer esFrameNumber,
        String unit,
        String calibration,
        String frameSelection,
        double ejectionFraction,
        Double edvMl,
        Double esvMl,
        Double kennedyEdvMl,
        Double kennedyEsvMl,
        Double kennedyEjectionFraction,
        String method) {
}
