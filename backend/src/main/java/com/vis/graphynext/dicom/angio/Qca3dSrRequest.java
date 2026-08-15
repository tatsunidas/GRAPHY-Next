/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

/**
 * 3D QCA（2 方向からの血管再構成）の結果を DICOM SR として書き出す要求
 * （{@code fw/angio-design.md} §10 / A6a）。
 *
 * <h3>🚨 2 方向を両方参照する</h3>
 * 3D の値は<b>どの 2 方向から作ったかで変わる</b>。片方しか残さない SR は再現できない。
 *
 * @param viewASopInstanceUid  方向 A の元インスタンス
 * @param viewAFrameNumber     方向 A のフレーム（<b>1 origin</b>）
 * @param viewBSopInstanceUid  方向 B の元インスタンス
 * @param viewBFrameNumber     方向 B のフレーム（<b>1 origin</b>）
 * @param separationDeg        2 方向の視線がなす角。これが小さいと三角測量が退化する
 * @param anchorCount          対応の固定点の数。<b>3 未満なら角度補正が掛かっていない</b>（§10.2.2）
 * @param anchorReprojectionPx アンカーの再投影誤差。<b>これが幾何の検算</b>。
 *                             対応付けの再投影誤差は幾何の指標にならないので書かない
 * @param angleCorrected       角度補正を掛けたか。掛けていない結果は装置の角度誤差をそのまま含む
 * @param lengthMm             3D 中心線の全長
 * @param minAreaMm2           最小断面積。<b>未校正なら null</b>（px の径から mm² は作れない）
 * @param minEquivalentDiameterMm 最小等価直径。同上
 * @param visibleFractionA     方向 A で見えている長さの割合（短縮の指標。§10.2.5）
 * @param visibleFractionB     方向 B での同じ値
 * @param calibration          校正の出自（人向け文字列）。null なら未校正
 * @param percentDiameterStenosis 直径狭窄率 [%]。断面が出せないなら null。
 *                             <b>比なので半値法の系統誤差はほぼ打ち消される</b>（§10.2.8）
 * @param percentAreaStenosis  面積狭窄率 [%]。同上
 * @param mldMm                最小血管径。<b>絶対値なので約 13% 過小</b>
 * @param rvdMm                MLD 位置での参照血管径。同上
 * @param lesionLengthMm       病変長
 */
public record Qca3dSrRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String viewASopInstanceUid,
        Integer viewAFrameNumber,
        String viewBSopInstanceUid,
        Integer viewBFrameNumber,
        double separationDeg,
        int anchorCount,
        double anchorReprojectionPx,
        boolean angleCorrected,
        double lengthMm,
        Double minAreaMm2,
        Double minEquivalentDiameterMm,
        Double visibleFractionA,
        Double visibleFractionB,
        String calibration,
        Double percentDiameterStenosis,
        Double percentAreaStenosis,
        Double mldMm,
        Double rvdMm,
        Double lesionLengthMm) {
}
