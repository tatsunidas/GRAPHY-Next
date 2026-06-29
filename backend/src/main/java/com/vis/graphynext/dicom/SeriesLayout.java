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
        List<ZSpatial> zSpatial) {

    public record Cell(int c, int z, int t, String sopInstanceUid) {
    }

    /** Z インデックス → ImagePositionPatient（Fusion trilinear 補間のスライス位置決定用）。 */
    public record ZSpatial(int z, double[] imagePositionPatient) {
    }

    /** 空間メタなしのレイアウト（{@link SeriesLayoutBuilder} の返り値用）。 */
    static SeriesLayout noSpatial(int nZ, int nC, int nT, String cDim, String tDim, List<Cell> cells) {
        return new SeriesLayout(nZ, nC, nT, cDim, tDim, cells, null, 0, 0, 0, 0, null);
    }
}
