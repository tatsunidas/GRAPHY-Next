/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import java.util.List;

/**
 * マスク（labelmap）→ DICOM SEG 書き出しリクエスト。
 *
 * frontend が各セグメントの**非空スライスごと**にマスク平面（rows*cols の 0/1 バイト列を Base64）と、
 * その参照 source スライスの SOPInstanceUID・IPP を送る。backend は参照シリーズのヘッダから患者/検査を継承し、
 * BINARY SEG を生成して保管庫へ取り込む（`fw/dicom-seg-rtstruct-design.md` S1）。
 *
 * @param studyInstanceUid        参照シリーズの StudyInstanceUID
 * @param seriesInstanceUid       参照シリーズの SeriesInstanceUID（患者/検査/テンプレート継承元）
 * @param rows                    行数（=参照画像 Rows）
 * @param columns                 列数（=参照画像 Columns）
 * @param imageOrientationPatient IOP 6 要素
 * @param pixelSpacing            [row, col] mm
 * @param sliceThickness          mm（0 なら省略）
 * @param frameOfReferenceUID     参照シリーズの FoR（null/空なら省略）
 * @param seriesDescription       生成シリーズの説明（null 可）
 * @param segments                セグメント群
 */
public record SegExportRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        int rows,
        int columns,
        double[] imageOrientationPatient,
        double[] pixelSpacing,
        double sliceThickness,
        String frameOfReferenceUID,
        String seriesDescription,
        List<Segment> segments) {

    /**
     * @param number セグメント番号（1-based）
     * @param label  セグメント名
     * @param color  RGB [r,g,b]（0..255）。null 可。
     * @param frames 非空スライスのフレーム群
     */
    public record Segment(int number, String label, int[] color, List<Frame> frames) {
    }

    /**
     * @param sopInstanceUid        参照 source スライスの SOPInstanceUID
     * @param imagePositionPatient  そのスライスの IPP [x,y,z]
     * @param mask                  rows*cols の 0/1 バイト列（行優先）を Base64 エンコードした文字列
     */
    public record Frame(String sopInstanceUid, double[] imagePositionPatient, String mask) {
    }
}
