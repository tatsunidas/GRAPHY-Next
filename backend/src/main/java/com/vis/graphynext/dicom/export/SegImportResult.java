/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import java.util.List;

/**
 * DICOM SEG 読込結果（frontend が Cornerstone labelmap（{@code csSeg.addSegmentations}）へ復元する）。
 * 書込 {@link SegExportRequest} と対称（`fw/mask-driven-pipelines-gap-analysis.md` 対応課題#2）。
 *
 * @param rows     行数（=参照画像 Rows）
 * @param columns  列数（=参照画像 Columns）
 * @param segments セグメント群
 */
public record SegImportResult(int rows, int columns, List<Segment> segments) {

    /**
     * @param number      セグメント番号（1-based）
     * @param label       SegmentLabel
     * @param color       RecommendedDisplayCIELabValue から復元した RGB [r,g,b]（0..255）。無ければ null。
     * @param description SegmentDescription（Volumetry 等の数値を書き込んだもの。無ければ null）
     * @param frames      非空スライスのフレーム群
     */
    public record Segment(int number, String label, int[] color, String description, List<Frame> frames) {
    }

    /**
     * @param referencedSopInstanceUid フレームが乗るスライスの参照 SOPInstanceUID（DerivationImageSequence
     *                                 から取得。無ければ null＝frontend 側で IPP 近傍マッチにフォールバック）
     * @param imagePositionPatient     そのフレームの IPP [x,y,z]（PlanePositionSequence。無ければ null）
     * @param mask                     rows*columns の 0/1 バイト列（行優先）を Base64 エンコードした文字列
     */
    public record Frame(String referencedSopInstanceUid, double[] imagePositionPatient, String mask) {
    }
}
