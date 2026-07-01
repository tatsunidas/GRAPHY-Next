/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import java.util.List;

/**
 * RTSTRUCT 読込結果の 1 ROI（frontend が Cornerstone アノテーションへ復元する）。
 *
 * @param name     ROI 名
 * @param color    RGB [r,g,b]（0..255）。null 可。
 * @param type     RTROIInterpretedType（null 可）
 * @param contours スライスごとの閉輪郭
 */
public record RtStructRoiDto(String name, int[] color, String type, List<Contour> contours) {

    /**
     * @param referencedSopInstanceUid 輪郭が乗るスライスの参照 SOPInstanceUID
     * @param points                   [x,y,z,...] 患者座標 mm
     */
    public record Contour(String referencedSopInstanceUid, double[] points) {
    }
}
