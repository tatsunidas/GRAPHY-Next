/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import java.util.List;

/**
 * GSPS から読み取った表示状態（{@code fw/angio-design.md} §14.1 / A10 の読み込み側）。
 *
 * <h3>🚨 「読めなかったもの」を必ず返す</h3>
 * 他社が書いた GSPS には、こちらが解釈しない項目（LUT で書かれた VOI・Display Shutter・
 * DISPLAY 単位の図形など）が普通に入っている。それらを<b>黙って落とすと、利用者から見ると
 * 「適用したのに元と違う」</b>——しかも何が違うのか分からない状態になる。
 * 解釈しなかった項目は {@link #warnings()} に**キーで**入れ、UI に出す。
 *
 * @param sopInstanceUid    この GSPS 自身の SOP Instance UID
 * @param referencedImages  参照している画像（複数あり得る。適用先を選ぶのは呼び出し側）
 * @param voi               Softcopy VOI LUT の WC/WW。LUT で書かれていたら null ＋ 警告
 * @param invert            Presentation LUT Shape が INVERSE か
 * @param rotation          0/90/180/270
 * @param flipHorizontal    左右反転
 * @param mask              DSA のマスク指定（非減算なら null）
 * @param calibration       Presentation Pixel Spacing（無ければ null）
 * @param polylines         図形（**画像ピクセル座標・0 origin**。PIXEL 単位のものだけ）
 * @param texts             注釈テキスト（同上）
 * @param warnings          解釈しなかった項目のキー
 */
public record XaPresentationState(
        String sopInstanceUid,
        String sopClassUid,
        String label,
        String description,
        String creator,
        List<ReferencedImage> referencedImages,
        Voi voi,
        boolean invert,
        int rotation,
        boolean flipHorizontal,
        Mask mask,
        Calibration calibration,
        List<Polyline> polylines,
        List<TextAnnotation> texts,
        List<String> warnings) {

    /** @param frameNumbers 参照フレーム（**1 origin**）。空なら全フレーム */
    public record ReferencedImage(String seriesInstanceUid, String sopInstanceUid, List<Integer> frameNumbers) {
    }

    public record Voi(double windowCenter, double windowWidth) {
    }

    /**
     * @param subPixelShiftRow 行方向（縦）のシフト [px]。⚠️ frontend の {@code dy}
     * @param subPixelShiftCol 列方向（横）のシフト [px]。⚠️ frontend の {@code dx}
     * @param applicableFrom   適用範囲の先頭フレーム（**1 origin**）。無ければ null
     */
    public record Mask(
            List<Integer> maskFrameNumbers,
            double subPixelShiftRow,
            double subPixelShiftCol,
            String operation,
            Integer applicableFrom,
            Integer applicableTo) {
    }

    public record Calibration(double mmPerPxRow, double mmPerPxCol) {
    }

    /** @param points [x0,y0,x1,y1,...]（**画像ピクセル座標・0 origin**） */
    public record Polyline(String layer, String graphicType, List<Double> points, boolean filled) {
    }

    public record TextAnnotation(String layer, String text, double anchorX, double anchorY) {
    }
}
