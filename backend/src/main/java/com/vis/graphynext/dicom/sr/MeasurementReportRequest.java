/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.sr;

import java.util.List;

/**
 * 計測レポート（DICOM SR）の生成要求。
 *
 * <p><b>DICOM はプラグインに書かせない</b>。呼び出し側（プラグイン／画面）は「何を測ったか」を
 * この形で渡すだけで、SR の構造・UID 採番・患者/検査属性の引き継ぎは本体が行う
 * （派生シリーズ H4b と同じ考え方）。
 *
 * @param studyInstanceUid  保存先のスタディ（この検査に属する SR として作る）
 * @param seriesDescription シリーズ説明（一覧に出る。プラグイン由来なら接頭辞が付く）
 * @param documentTitle     文書タイトル（自由文。既定は "Imaging Measurement Report"）
 * @param observerName      観測者名（読影医）。空なら Person Observer を書かない
 * @param groups            計測グループ（＝病変 1 つ）。**画像参照を持つのは実測した回だけ**
 * @param findings          所見テキスト（経時判定のまとめなど）。画像参照を持たない
 * @param producer          出所（プラグイン id/名前/版）。null なら本体自身が作ったものとして扱う
 */
public record MeasurementReportRequest(
        String studyInstanceUid,
        String seriesDescription,
        String documentTitle,
        String observerName,
        List<MeasurementGroup> groups,
        List<Finding> findings,
        Producer producer) {

    /**
     * 計測グループ（TID 1500 の Measurement Group 相当）。
     *
     * @param trackingId    病変の追跡 ID（人が読む識別子）
     * @param trackingUid   追跡 UID。省略時は本体が採番する（同じ病変を時系列で結ぶ鍵）
     * @param findingText   所見の説明（"Target lesion" 等）。コード化はしない（後述の制限）
     * @param seriesInstanceUid 計測した画像のシリーズ
     * @param sopInstanceUid    計測した画像のインスタンス
     * @param measurements  この病変の計測値
     */
    public record MeasurementGroup(
            String trackingId,
            String trackingUid,
            String findingText,
            String seriesInstanceUid,
            String sopInstanceUid,
            List<Measurement> measurements) {
    }

    /**
     * 計測値 1 つ。
     *
     * @param type  {@code longAxis} / {@code shortAxis}（それ以外は拒否する）
     * @param value 値
     * @param unit  単位（既定 mm）
     */
    public record Measurement(String type, Double value, String unit) {
    }

    /**
     * 所見テキスト 1 行。
     *
     * @param label 見出し（"Baseline" / "Best overall response" 等）
     * @param text  本文
     */
    public record Finding(String label, String text) {
    }

    /** 出所（プラグイン）。 */
    public record Producer(String id, String name, String version) {
    }
}
