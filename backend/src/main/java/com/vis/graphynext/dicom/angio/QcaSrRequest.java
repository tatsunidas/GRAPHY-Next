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
 * @param manualCorrection 手修正の内容（"中間点 2 / エッジ 5 点 / 参照径=健常部指定" のような
 *                      人向け文字列）。全自動なら null。
 *                      <b>手で直した値を自動値と同じ顔で保存しない</b>ためのフィールド
 *                      （設計 §8.6）。読む側が再現性・監査可能性を判断できなくなる
 */
public record QcaSrRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String sopInstanceUid,
        Integer frameNumber,
        String unit,
        String calibration,
        String vesselLabel,
        String manualCorrection,
        /*
         * 径を何で測ったか（"half-max" / "densitometric"）。null なら半値法として扱う。
         * 設計 §16.5。<b>数値だけ残して測り方を落とすと、他社の QCA と比べたときに
         * 差の原因が分からなくなる</b>（半値法と密度計測では絶対値が 10% 以上違う）。
         */
        String diameterMethod,
        double mld,
        double rvd,
        double percentDiameterStenosis,
        double percentAreaStenosis,
        double lesionLength) {
}
