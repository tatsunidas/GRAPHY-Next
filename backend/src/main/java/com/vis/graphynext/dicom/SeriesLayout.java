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
 * @param cDimension C 次元の由来（"Echo"/"Bvalue" 等。単一次元なら null）
 * @param tDimension T 次元の由来（"Temporal"/"Trigger" 等。単一次元なら null）
 * @param cells      各フレームの (c,z,t) → SOPInstanceUID
 */
public record SeriesLayout(int nZ, int nC, int nT, String cDimension, String tDimension, List<Cell> cells) {

    public record Cell(int c, int z, int t, String sopInstanceUid) {
    }
}
