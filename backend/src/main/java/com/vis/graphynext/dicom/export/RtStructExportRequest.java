/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import java.util.List;

/**
 * 2D ベクタ ROI → DICOM RT Structure Set 書き出しリクエスト。
 * 各 ROI はスライスごとの閉輪郭（患者座標 mm の点列）で表す（`fw/dicom-seg-rtstruct-design.md` S2）。
 *
 * @param studyInstanceUid    参照シリーズの StudyInstanceUID
 * @param seriesInstanceUid   参照シリーズの SeriesInstanceUID（患者/検査/テンプレート継承元）
 * @param frameOfReferenceUID 参照シリーズの FrameOfReferenceUID（必須）
 * @param structureSetLabel   ストラクチャセットのラベル（null 可）
 * @param rois                ROI 群
 */
public record RtStructExportRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String frameOfReferenceUID,
        String structureSetLabel,
        List<Roi> rois) {

    /**
     * @param number   ROI 番号（1-based）
     * @param name     ROI 名
     * @param color    RGB [r,g,b]（0..255）。null 可。
     * @param type     RTROIInterpretedType（"ORGAN" 等。null 可）
     * @param contours スライスごとの閉輪郭
     */
    public record Roi(int number, String name, int[] color, String type, List<Contour> contours) {
    }

    /**
     * @param sopInstanceUid 輪郭が乗るスライスの参照 SOPInstanceUID
     * @param points         [x,y,z,x,y,z,...]（患者座標 mm、閉輪郭の頂点列）
     */
    public record Contour(String sopInstanceUid, double[] points) {
    }
}
