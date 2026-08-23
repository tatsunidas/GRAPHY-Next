/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import java.util.List;

/**
 * 線量分布 → DICOM RT Dose 書き出しリクエスト（プラグイン host API の H23）。
 *
 * <h3>なぜ派生シリーズ（H4b）では足りないか</h3>
 *
 * <p>線量マップは派生シリーズとしても保存できるが、それは他システムから見ると<b>ただの画像</b>で、
 * 「線量」としては読まれない。RT Dose Storage で出すと、DVH を引く・線量として重ねる、といった
 * 受け側の機能がそのまま使える。
 *
 * <h3>幾何はプラグインに書かせない、という原則の例外について</h3>
 *
 * <p>RTDOSE は「参照画像のスライスに 1:1 で対応する」とは限らない（線量格子は独自の格子で持てる）。
 * そのため H4b と違い、<b>格子はリクエストで明示的に受け取る</b>。ただし
 * <b>FrameOfReferenceUID は参照シリーズから引き継ぐ</b>（呼び出し側に書かせると
 * 「別の座標系の線量を同じ座標系だと偽る」ことができてしまうため）。
 *
 * @param studyInstanceUid   参照シリーズの StudyInstanceUID（この検査に属する RTDOSE として作る）
 * @param seriesInstanceUid  参照シリーズの SeriesInstanceUID（患者/検査/FoR の継承元）
 * @param seriesDescription  生成シリーズの説明（null 可。プラグイン由来なら接頭辞が付く）
 * @param seriesNumber       シリーズ番号（null なら本体が採番）
 * @param rows               線量格子の行数
 * @param columns            線量格子の列数
 * @param imageOrientationPatient IOP 6 要素（全フレーム共通）
 * @param imagePositionPatient    先頭フレームの IPP [x,y,z]（mm, LPS）
 * @param pixelSpacing       [行間隔, 列間隔]（mm, DICOM PixelSpacing 順）
 * @param gridFrameOffsetVector フレームごとのオフセット（mm）。<b>先頭は 0</b>。要素数＝フレーム数
 * @param doseUnits          {@code GY} または {@code RELATIVE}
 * @param doseType           {@code PHYSICAL} / {@code EFFECTIVE} / {@code ERROR}
 * @param doseSummationType  {@code PLAN} 等（DICOM の列挙値。{@link RtDoseExportService} が検査する）
 * @param doseComment        自由文（既定の注記。null 可）
 * @param doseGridScaling    格納値 → 線量 [Gy] の係数（>0）
 * @param tissueHeterogeneityCorrection {@code IMAGE} / {@code ROI_OVERRIDE} / {@code WATER}（null 可）
 * @param pixels             Base64 の <b>uint16 リトルエンディアン</b>（長さ = rows*columns*frames*2 バイト）
 * @param referencedSopInstanceUids 由来となった画像インスタンス（証跡。null/空可）
 * @param referencedRtPlan   参照 RT Plan（<b>核医学の線量評価には通常存在しない</b>。null 可）
 * @param producer           出所（プラグイン id/名前/版）。null なら本体自身が作ったものとして扱う
 */
public record RtDoseExportRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String seriesDescription,
        Integer seriesNumber,
        int rows,
        int columns,
        double[] imageOrientationPatient,
        double[] imagePositionPatient,
        double[] pixelSpacing,
        double[] gridFrameOffsetVector,
        String doseUnits,
        String doseType,
        String doseSummationType,
        String doseComment,
        double doseGridScaling,
        String tissueHeterogeneityCorrection,
        String pixels,
        List<String> referencedSopInstanceUids,
        ReferencedRtPlan referencedRtPlan,
        Producer producer) {

    /**
     * 参照 RT Plan。
     *
     * <p>RT Dose モジュールの {@code ReferencedRTPlanSequence} は Type 1C で、
     * {@code DoseSummationType} が {@code PLAN} 等のとき<b>必須</b>である。ところが
     * <b>核医学（放射性医薬品）の線量評価には RT Plan が存在しない</b>。
     * 本体はここを<b>捏造しない</b>（無いものを在ることにしない）。代わりに、
     * 与えられなかった場合は {@link RtDoseExportService.Result#warnings()} に
     * 「Type 1C を満たしていない」ことを載せ、確認ダイアログでユーザーに見せる。
     */
    public record ReferencedRtPlan(String sopClassUid, String sopInstanceUid) {}

    /** 出所（プラグイン）。派生シリーズ H4b と同じ扱い。 */
    public record Producer(String id, String name, String version) {}
}
