/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.imagej;

/**
 * ImageJ ROI の交換用 DTO（画像ピクセル座標）。
 *
 * <p>フロントは Cornerstone アノテーション（world 座標）を worldToImageCoords で画像ピクセルへ変換して
 * この DTO を送る。{@code type} は ImageJ の ROI 種別に対応する。多角形系は {@code xs/ys}、矩形/楕円は
 * bbox（{@code bx,by,bw,bh}）を使う。
 */
public record ImageJRoiDto(
        String name,        // ROI 名（zip エントリ名にも使用）
        String type,        // polygon | freehand | polyline | oval | rect | point | angle
        int position,       // スライス位置（1-based, 0=未指定）
        float[] xs,         // 頂点 x（画素）: polygon/freehand/polyline/point/angle
        float[] ys,         // 頂点 y（画素）
        Double bx, Double by, Double bw, Double bh, // bbox（画素）: oval/rect
        Integer strokeColor // 0xAARRGGBB（任意）
) {}
