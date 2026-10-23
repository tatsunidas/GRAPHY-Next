/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import java.util.List;

/**
 * シリーズの軸モデル。<b>この型が「軸の意味」の定義の正本</b>（詳細・形式ごとの割り当て表は
 * {@code fw/series-axes.md}）。
 *
 * <h3>2 つのモデル</h3>
 * <b>(1) Z / C / T ＝ ボリュームデータ用。</b>x,y（画像内）に Z・C・T を加えた 5 次元。
 * <ul>
 *   <li><b>Z</b>: 空間スライス位置。ImagePositionPatient を ImageOrientationPatient の法線へ投影した距離
 *       （無ければ SliceLocation / InstanceNumber）。患者座標の 3 次元位置を持つ。</li>
 *   <li><b>T</b>: 同じ空間位置を繰り返し撮った時間（TemporalPositionIdentifier / TriggerTime）。</li>
 *   <li><b>C</b>: 同じ空間位置の別の収集条件（EchoNumbers / DiffusionBValue / EchoTime など。
 *       DICOM の「channel」は WSI のみのため、放射線では追加次元として解釈）。</li>
 * </ul>
 * T と C は<b>「同じ 3D 位置を繰り返し撮影している」ことが前提</b>。導出は {@link SeriesLayoutBuilder}。
 *
 * <p><b>(2) Shot / Frame ＝ 投影・シネ用（体積ではない画像）。</b>空間位置の繰り返しを前提としない。
 * <ul>
 *   <li><b>Shot</b>: 撮影の単位（1 回の曝射・1 本のシネ・1 方向）。{@code kind="shot"}。
 *       撮影同士に空間的な関係は無い（XA の 2 方向、複数本のシネなど）。内部では Z 軸に載せる
 *       （{@link Axes} が UI に "Z" と出さない）。</li>
 *   <li><b>Frame</b>: 1 つの Shot の中の、時間順に並んだフレーム。{@code kind="frame"}。
 *       単一フレームの画像は Frame = 1。内部では T 軸に載せ、スタック軸（{@code stackAxis="t"}）にする。
 *       Shot ごとにフレーム数が違ってよい（セルは実在するフレームの分だけ作る）。</li>
 *   <li>Shot × Frame の形式は XA / XRF（{@link XaFrameExpander}）。今後、フレームが時間順の列である
 *       US のシネなどに広げる。</li>
 * </ul>
 * 血管内画像（IVUS / OCT）は Frame に加えて、カテーテルのプルバック軸（{@code kind="pullback"}）を持つ。
 *
 * <h3>どちらを使うか</h3>
 * 患者座標に位置を持つ（体積として再構成・MPR・参照線・Sync が意味を持つ）ものは Z/C/T、
 * 位置の繰り返しを前提にできない投影像・シネは Shot × Frame。CR / DX は 1 SOP = 1 フレームの投影像で
 * 本来は Shot だが、運用上は従来の Z スタック（ホイール送り）に載っている（軸の表記だけ Z）。
 *
 * <h3>各軸の kind</h3>
 * {@link Axis#kind()} は UI の機能の可否を決める。{@code "slice"} のときだけ ThickSlab・Sync・参照線・MPR が
 * 有効になる（それ以外は空間スライス軸ではない）。
 *
 * <h3>導出の概要（{@link SeriesLayoutBuilder}、従来経路）</h3>
 * <ul>
 *   <li>Z: ImagePositionPatient を ImageOrientationPatient 法線へ投影した距離（無ければ
 *       SliceLocation/InstanceNumber）。</li>
 *   <li>T: TemporalPositionIdentifier / TriggerTime。</li>
 *   <li>C: EchoNumbers / DiffusionBValue / EchoTime。</li>
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
 * @param axes                   軸の提示（UI ラベル・種別）とスタック軸。null なら既定
 *                               （Z=slice / C / T、stackAxis="z"）＝ CT/MR の従来動作。
 *                               fw/angio-design.md §5.7。
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
        PixelFormat pixelFormat,
        Axes axes) {

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

    /**
     * 1 つの軸の提示。
     *
     * @param label UI に出すラベル（"Z" / "Shot" / "Frame" 等）
     * @param kind  軸の種別（"slice" / "shot" / "frame" / "pullback" / "echo" / "bvalue" / "temporal" /
     *              "generic"）。
     *              UI はこれを見て ThickSlab・Sync・参照線など「空間スライス軸を前提とする機能」の
     *              有効/無効を決める。
     */
    public record Axis(String label, String kind) {
    }

    /**
     * 軸の提示モデル（fw/angio-design.md §5.7）。
     *
     * <p>UI 側に「XA なら…」という分岐を撒かないための仕組み。レイアウトが軸の意味を供給し、
     * UI は「要素数 &gt; 1 の軸だけスライダーを描く」という汎用規則で描画する。
     *
     * @param z         Z 軸の提示。null なら既定（"Z" / slice）
     * @param c         C 軸の提示。null なら既定（"C"）
     * @param t         T 軸の提示。null なら既定（"T"）
     * @param stackAxis 画像スタック（= Cornerstone StackViewport の imageIds ＝ホイール送り／
     *                  Grid 表示／プリフェッチの単位）をどの軸に割り当てるか。{@code "z"}（既定）か {@code "t"}。
     *                  XA シネは {@code "t"}（フレーム送りのたびに setStack が走るのを避ける）。
     */
    public record Axes(Axis z, Axis c, Axis t, String stackAxis) {
    }

    /** 空間メタなしのレイアウト（{@link SeriesLayoutBuilder} の返り値用）。 */
    static SeriesLayout noSpatial(int nZ, int nC, int nT, String cDim, String tDim, List<Cell> cells) {
        return new SeriesLayout(nZ, nC, nT, cDim, tDim, cells, null, 0, 0, 0, 0, null, null, null, null);
    }
}
