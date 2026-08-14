/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import java.util.List;

/**
 * XA/XRF Grayscale Softcopy Presentation State（GSPS）の作成要求
 * （{@code fw/angio-design.md} §14.1 / A10）。
 *
 * <p>通常の GSPS（11.1）ではなく <b>XA/XRF GSPS（11.5）</b>を作るのは、
 * <b>DSA のマスク指定とピクセルシフトを保存できるのがこれだけ</b>だから。これが無いと
 * A2 で作った差分表示を再現できない。
 *
 * @param sopInstanceUid 対象インスタンス（XA なら 1 ラン）
 * @param frameNumbers   対象フレーム（**1 origin**）。null/空なら全フレーム
 * @param label          ContentLabel（DICOM CS: 大文字・空白不可。整形は writer 側で行う）
 * @param voi            表示 VOI（Softcopy VOI LUT）
 * @param invert         白黒反転（Presentation LUT Shape = INVERSE）
 * @param rotation       0/90/180/270
 * @param flipHorizontal 左右反転
 * @param mask           DSA のマスク指定（null なら非減算＝Recommended Viewing Mode は NAT）
 * @param calibration    空間校正。Displayed Area の Presentation Pixel Spacing として保存する
 *                       （A3 の「校正値の永続化」はここで満たす）
 * @param polylines      折れ線（QCA の中心線・エッジなど）。座標は**画像ピクセル座標（0 origin, 小数可）**
 * @param texts          注釈テキスト
 */
public record AngioPresentationRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String sopInstanceUid,
        List<Integer> frameNumbers,
        String label,
        String description,
        String creator,
        Voi voi,
        Boolean invert,
        Integer rotation,
        Boolean flipHorizontal,
        Mask mask,
        Calibration calibration,
        List<Polyline> polylines,
        List<TextAnnotation> texts) {

    public record Voi(double windowCenter, double windowWidth) {
    }

    /**
     * @param maskFrameNumbers  マスクにするフレーム（**1 origin**）
     * @param subPixelShiftRow  行方向（縦）のシフト [px]
     * @param subPixelShiftCol  列方向（横）のシフト [px]
     * @param operation         MaskOperation（既定 "AVG_SUB"）
     */
    public record Mask(
            List<Integer> maskFrameNumbers,
            Double subPixelShiftRow,
            Double subPixelShiftCol,
            String operation) {
    }

    /**
     * @param type        PixelSpacingCalibrationType 相当（"FIDUCIAL" / "GEOMETRY"）
     * @param description 校正の説明（"6Fr catheter" 等）。**出自を残すのが目的**
     */
    public record Calibration(Double mmPerPxRow, Double mmPerPxCol, String type, String description) {
    }

    /**
     * @param points 画像ピクセル座標の並び [x0,y0,x1,y1,...]（**0 origin**。GSPS の PIXEL 単位へは writer が変換）
     * @param rgb    表示色（0-255 × 3）。null なら層の既定色
     */
    public record Polyline(String layer, List<Double> points, Boolean filled, int[] rgb) {
    }

    /** @param anchorX 画像ピクセル座標（0 origin） */
    public record TextAnnotation(String layer, String text, double anchorX, double anchorY) {
    }
}
