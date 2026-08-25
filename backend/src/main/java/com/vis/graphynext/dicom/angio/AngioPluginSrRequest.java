/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

/**
 * プラグインが書く アンギオ解析 SR の要求（host API の H37 ／ {@code fw/angio-design.md} §22.3 の G3）。
 *
 * <h3>なぜ既存の 4 エンドポイントと分けるのか</h3>
 * 中身（{@link QcaSrRequest} 等）は本体の解析ダイアログが出すものと**同一**で、書き手も同じ
 * {@code *SrWriter} である。違うのは<b>出所の記録が必須</b>だという 1 点:
 * プラグインが書いた SR は {@code SeriesDescription} に {@code [Plugin] } が付き、
 * {@code ContributingEquipmentSequence} にプラグイン id・版が入らなければならない
 * （H4b / H9 と同じ規則）。
 *
 * <p>既存の record に {@code producer} を足す形にしなかったのは、
 * <b>本体の経路では producer が常に null になり、「付け忘れ」と「本体が書いた」の区別が
 * 型から消える</b>ため。経路を分ければ、プラグイン経路では producer を**必須にできる**。
 *
 * <p>🔴 <b>DICOM はプラグインに書かせない</b>という方針はここでも同じ。プラグインが渡すのは
 * 「何を測ったか」だけで、SR の構造・UID 採番・患者/検査属性の継承は本体（{@code *SrWriter}）が行う。
 *
 * @param kind     "qca" / "qva" / "qlv" / "qca3d"
 * @param producer 出所（プラグイン id・表示名・版）。**必須**
 */
public record AngioPluginSrRequest(
        String kind,
        Producer producer,
        QcaSrRequest qca,
        QvaSrRequest qva,
        QlvSrRequest qlv,
        Qca3dSrRequest qca3d) {

    /** 出所。{@code MeasurementReportRequest.Producer}（H9）と同じ形にそろえてある。 */
    public record Producer(String id, String name, String version) {
    }
}
