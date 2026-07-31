/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import java.util.List;

/**
 * シリーズの 5 次元（x,y は画像内）＝ Z(空間スライス) × C(チャンネル相当) × T(時間) 構造。
 *
 * <p>DICOM 準拠の導出（{@link SeriesLayoutBuilder}）:
 * <ul>
 *   <li>Z: ImagePositionPatient を ImageOrientationPatient 法線へ投影した距離（無ければ
 *       SliceLocation/InstanceNumber）。</li>
 *   <li>T: TemporalPositionIdentifier / TriggerTime。</li>
 *   <li>C: EchoNumbers / DiffusionBValue / EchoTime（DICOM の「channel」は WSI のみのため、
 *       放射線では追加次元として解釈）。</li>
 * </ul>
 *
 * @param cDimension             C 次元の由来（"Echo"/"Bvalue" 等。単一次元なら null）
 * @param tDimension             T 次元の由来（"Temporal"/"Trigger" 等。単一次元なら null）
 * @param cells                  各フレームの (c,z,t) → SOPInstanceUID
 * @param imageOrientationPatient IOP 6 要素（行/列方向余弦）。Fusion 空間整合用。null なら未取得。
 * @param pixelSpacingRow        行間隔 [mm]。0 なら未取得。
 * @param pixelSpacingCol        列間隔 [mm]。0 なら未取得。
 * @param imageWidth             画像幅 [px]。0 なら未取得。
 * @param imageHeight            画像高さ [px]。0 なら未取得。
 * @param zSpatial               Z インデックスごとの ImagePositionPatient。Fusion 精密アライメント用。null なら未取得。
 * @param frameOfReferenceUID    FrameOfReferenceUID。セグメンテーション labelmap のメタデータプロバイダ／
 *                               volume 再構成（isValidVolume）の FoR 一致判定用。null なら未取得。
 * @param pixelFormat            ボクセルあたりのバイト数を決めるピクセル形式。ボリューム構築前の
 *                               メモリ量予測（fw/volume-memory-guard.md V2）用。null なら未取得。
 */
public record SeriesLayout(
        int nZ, int nC, int nT,
        String cDimension, String tDimension,
        List<Cell> cells,
        double[] imageOrientationPatient,
        double pixelSpacingRow,
        double pixelSpacingCol,
        int imageWidth,
        int imageHeight,
        List<ZSpatial> zSpatial,
        String frameOfReferenceUID,
        PixelFormat pixelFormat) {

    /**
     * 各 (c,z,t) に対応するフレーム。
     *
     * @param frame Siemens モザイクのタイル番号（0..N-1）。非モザイク（1 インスタンス=1 画像）は -1。
     *              frontend は frame&gt;=0 のとき {@code /instances/{sop}/frames/{frame}/file} を読む。
     */
    public record Cell(int c, int z, int t, String sopInstanceUid, int frame) {
        /** 非モザイク（通常の単一フレーム）セル。 */
        public Cell(int c, int z, int t, String sopInstanceUid) {
            this(c, z, t, sopInstanceUid, -1);
        }
    }

    /** Z インデックス → ImagePositionPatient（Fusion trilinear 補間のスライス位置決定用）。 */
    public record ZSpatial(int z, double[] imagePositionPatient) {
    }

    /**
     * ボクセルあたりのバイト数を決めるピクセル形式。
     *
     * <p>frontend がボリューム構築前に必要メモリ量を予測するために使う
     * （設計: {@code fw/volume-memory-guard.md} §2.1・§5）。Cornerstone が確保する TypedArray の型は
     * BitsAllocated だけでは決まらない — <b>RescaleSlope が非整数だと 16bit でも Float32Array
     * （4B/voxel）に化ける</b>ため、PET を 2 倍見誤らないよう rescale も一緒に返す。
     *
     * <p>5 つを個別のフィールドではなく 1 つのレコードにまとめてあるのは、
     * (1) 親 record の位置引数が 18 個になるのを避ける、(2)「取得できた/できなかった」を
     * null 1 つで表せる（0 をセンチネルにすると rescaleSlope=0 が「未取得」と区別できない）ため。
     *
     * @param bitsAllocated       BitsAllocated(0028,0100)
     * @param pixelRepresentation PixelRepresentation(0028,0103)。1 = signed
     * @param samplesPerPixel     SamplesPerPixel(0028,0002)。RGB なら 3
     * @param rescaleSlope        RescaleSlope(0028,1053)。未設定なら 1
     * @param rescaleIntercept    RescaleIntercept(0028,1052)。未設定なら 0
     */
    public record PixelFormat(
            int bitsAllocated,
            int pixelRepresentation,
            int samplesPerPixel,
            double rescaleSlope,
            double rescaleIntercept) {
    }

    /** 空間メタなしのレイアウト（{@link SeriesLayoutBuilder} の返り値用）。 */
    static SeriesLayout noSpatial(int nZ, int nC, int nT, String cDim, String tDim, List<Cell> cells) {
        return new SeriesLayout(nZ, nC, nT, cDim, tDim, cells, null, 0, 0, 0, 0, null, null, null);
    }
}
