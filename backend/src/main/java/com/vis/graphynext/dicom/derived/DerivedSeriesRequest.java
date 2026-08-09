/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import java.util.List;

/**
 * 派生（セカンダリ）シリーズ生成リクエスト。GRAPHY-Next Slicer の任意断面リスライス結果を
 * 元シリーズ属性を引き継ぎつつ新シリーズとして保存する（設計 {@code fw/slicer-design.md} §7）。
 *
 * <p>元 Study/FrameOfReference/患者・検査属性は維持し、SeriesInstanceUID/SOPInstanceUID を新規採番、
 * ImagePositionPatient/ImageOrientationPatient/PixelSpacing/SliceThickness を再構成値で更新する。
 * IOP は全スライス共通（Reverse は InstanceNumber と IPP の並び順で表現。IOP は変更しない）。
 *
 * <p><b>幾何の省略（Curved MPR 等）:</b> 曲面/平坦化再構成は単一の平面位置・向きを持たないため、
 * {@code imageOrientationPatient} を null/空、各フレームの {@code imagePositionPatient} を null/空にできる。
 * その場合 IOP/IPP タグは書かず、空間登録を偽装しないよう FrameOfReferenceUID も引き継がない。
 * PixelSpacing は常に必須（出力ピクセルの物理サイズを表す）。
 *
 * @param studyInstanceUid    元 Study UID（維持）
 * @param seriesInstanceUid   元 Series UID（属性テンプレート取得元）
 * @param seriesDescription   新シリーズ説明
 * @param seriesNumber        新シリーズ番号（null なら backend で採番）
 * @param rows                各フレームの行数
 * @param columns             各フレームの列数
 * @param pixelSpacing        [行間隔, 列間隔]（mm, DICOM PixelSpacing 順）
 * @param sliceThickness      スライス厚（mm）
 * @param spacingBetweenSlices スライス中心間隔（mm）
 * @param imageOrientationPatient IOP 6 要素（全スライス共通）。null/空 なら幾何なし（Curved MPR 等）
 * @param derivationDescription   派生内容の説明（null なら既定の Oblique reslice 文言）
 * @param rescaleSlope        Rescale Slope（null なら 1.0＝恒等。プラグイン由来の値マップは
 *                            Float32 を Int16 に量子化するため呼び出し側が係数を渡す）
 * @param rescaleIntercept    Rescale Intercept（null なら 0.0＝恒等）
 * @param rescaleType         RescaleType(0028,1054)（null なら CT のみ "HU"、他は書かない）
 * @param pixelPaddingValue   PixelPaddingValue(0028,0120) の<b>格納値</b>（null なら書かない）。
 *                            プラグイン出力で「データ無し」を埋めた背景値を明示するために使う
 * @param producer            プラグイン由来の場合の出所（null なら本体の機能による生成）
 * @param frames              スライス毎（InstanceNumber 昇順で並べる）
 */
public record DerivedSeriesRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String seriesDescription,
        Integer seriesNumber,
        int rows,
        int columns,
        double[] pixelSpacing,
        double sliceThickness,
        double spacingBetweenSlices,
        double[] imageOrientationPatient,
        /**
         * 出力の空間基準（FrameOfReferenceUID）を**元シリーズ以外**に置きたい場合に指定する。
         *
         * <p>位置合わせの結果を保存する場合（R5）、リサンプルした moving は
         * <b>fixed の座標系にある</b>。元シリーズ（moving）の FoR を引き継ぐと
         * 「元の PET と同じ座標系だ」と偽ることになり、FoR を信じる他ツールが
         * 位置合わせ済みと誤解する。null なら従来どおり元シリーズから引き継ぐ。
         */
        String frameOfReferenceUid,
        String derivationDescription,
        Double rescaleSlope,
        Double rescaleIntercept,
        String rescaleType,
        Integer pixelPaddingValue,
        Producer producer,
        List<Frame> frames) {

    /**
     * プラグインが作ったシリーズであることの出所（`fw/plugin-architecture.md` §7 の H4b）。
     *
     * <p>これが付いていると、{@link DerivedSeriesService} は
     * ①`SeriesDescription` に接頭辞（`[Plugin] `）を付け、
     * ②`ContributingEquipmentSequence` と `DerivationDescription` に id・版を書く。
     * **他システムで開いても人と機械の両方が「プラグイン出力」と分かる**ようにするため
     * （プラグインは本体と同じ権限で動くので、出力の由来を消せる状態にしない）。
     *
     * @param id      plugin.json の id
     * @param name    表示名
     * @param version 版
     */
    public record Producer(String id, String name, String version) {}

    /**
     * 1 スライス。
     *
     * @param instanceNumber       InstanceNumber（1 始まり）
     * @param imagePositionPatient IPP [x,y,z]（mm, LPS）。null/空 なら IPP タグを書かない（Curved MPR 等）
     * @param pixels               Base64 の Int16 リトルエンディアン画素（長さ = rows*columns*2 バイト）
     */
    public record Frame(int instanceNumber, double[] imagePositionPatient, String pixels) {}
}
