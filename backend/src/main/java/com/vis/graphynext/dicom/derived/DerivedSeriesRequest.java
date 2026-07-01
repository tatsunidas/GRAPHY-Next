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
        String derivationDescription,
        List<Frame> frames) {

    /**
     * 1 スライス。
     *
     * @param instanceNumber       InstanceNumber（1 始まり）
     * @param imagePositionPatient IPP [x,y,z]（mm, LPS）。null/空 なら IPP タグを書かない（Curved MPR 等）
     * @param pixels               Base64 の Int16 リトルエンディアン画素（長さ = rows*columns*2 バイト）
     */
    public record Frame(int instanceNumber, double[] imagePositionPatient, String pixels) {}
}
