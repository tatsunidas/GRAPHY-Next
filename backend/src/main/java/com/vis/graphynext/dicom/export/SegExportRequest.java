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
 * @param producer                プラグイン由来の場合の出所（null なら本体の機能による生成）
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
        List<Segment> segments,
        Producer producer) {

    /**
     * プラグインが作った SEG であることの出所（host API の H22）。
     *
     * <p>派生シリーズ（H4b）・SR（H9）・RTDOSE（H23）と同じ扱い:
     * ①`SeriesDescription` に接頭辞（`[Plugin] `）を付け、
     * ②`ContributingEquipmentSequence` に id・版を書く。
     * <b>プラグインは本体と同じ権限で動くので、出力の由来を消せる状態にしない。</b>
     *
     * <p>⚠ ここが抜けていたことに実機検証で気付いた（2026-08-23）。SEG だけ、他の 3 経路と違って
     * 出所が残らなかった。
     */
    public record Producer(String id, String name, String version) {}

    /**
     * @param number      セグメント番号（1-based）
     * @param label       セグメント名
     * @param color       RGB [r,g,b]（0..255）。null 可。
     * @param description SegmentDescription へ書き込む説明文（Volumetry 等の計測結果）。null/空なら省略。
     * @param frames      非空スライスのフレーム群
     */
    public record Segment(int number, String label, int[] color, String description, List<Frame> frames) {
    }

    /**
     * @param sopInstanceUid        参照 source スライスの SOPInstanceUID
     * @param imagePositionPatient  そのスライスの IPP [x,y,z]
     * @param mask                  rows*cols の 0/1 バイト列（行優先）を Base64 エンコードした文字列。
     *                              前景ゼロの平面は転送量削減のため空文字列（全 0 平面として扱う）。
     */
    public record Frame(String sopInstanceUid, double[] imagePositionPatient, String mask) {
    }
}
