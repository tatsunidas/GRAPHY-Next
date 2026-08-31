/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

/**
 * QVA（末梢・脳血管）解析結果を DICOM SR として書き出す要求（{@code fw/angio-design.md} §9.1 / A5a）。
 *
 * <p>QCA（{@link QcaSrRequest}）と分けているのは、<b>瘤の指標と、瘤にだけ付く限界</b>
 * （1 方向の投影で測った最大径であること）が増えるため。QCA の SR に瘤の欄を混ぜると、
 * 冠動脈の SR に空の瘤欄が並ぶ。
 *
 * @param unit          "mm" または "px"（未校正なら px のまま書く。mm を騙らない）
 * @param calibration   校正の出自（人向け文字列）
 * @param manualCorrection 手修正の内容。全自動なら null（設計 §8.6）
 * @param dilation      拡張（瘤）。<b>拡張が無ければ null</b>。0 で埋めると「瘤 0mm」という
 *                      別の主張になる
 */
public record QvaSrRequest(
        String studyInstanceUid,
        String seriesInstanceUid,
        String sopInstanceUid,
        Integer frameNumber,
        String unit,
        String calibration,
        String vesselLabel,
        String manualCorrection,
        /*
         * 径を何で測ったか（"half-max" / "densitometric"）。null なら半値法として扱う。
         * 設計 §16.5。<b>拡張比（最大径 / 参照径）は太さの違う 2 点の比なので、半値法の
         * 係数は打ち消されない</b>（%DS とはここが違う）。だから測り方を必ず残す。
         */
        String diameterMethod,
        double mld,
        double rvd,
        double percentDiameterStenosis,
        double lesionLength,
        Dilation dilation) {

    /**
     * 拡張（瘤）の計測。
     *
     * @param ratio        最大径 / 参照径。🔴 <b>%DS と違って、半値法の係数はここでは
     *                     打ち消されない</b>——太さの違う 2 点の比であり、係数は径と断面の形に
     *                     依存するため（§16.4）。密度計測（A4c）ならその依存は無い
     * @param eccentricity 0（全周性＝紡錘状）〜1（片側だけ＝嚢状）。測れなければ null
     * @param aneurysmal   {@code aneurysmRatio} 倍以上か。<b>基準そのものも SR の本文に書く</b>
     * @param aneurysmRatio 判定に使った比。<b>フロントの画面に出ているのと同じ値</b>を受け取る
     *                      （設定 {@code xa.aneurysmRatio} で変わる）。null なら既定 1.5。
     *                      🔴 ここを固定値にしてはいけない —— 画面で 1.3 と判定したものが
     *                      「criterion 1.5」と書かれた SR になり、<b>保存物だけが嘘をつく</b>
     */
    public record Dilation(
            double maxDiameter,
            double ratio,
            double percentDilation,
            double length,
            double proximalNeck,
            double distalNeck,
            Double eccentricity,
            boolean aneurysmal,
            Double aneurysmRatio) {

        /** 判定に使った比（未指定なら既定 1.5）。 */
        public double criterion() {
            return aneurysmRatio != null && Double.isFinite(aneurysmRatio) && aneurysmRatio > 1.0
                    ? aneurysmRatio
                    : DEFAULT_ANEURYSM_RATIO;
        }
    }

    /** 「動脈瘤」と呼ぶ比の既定値。フロント（{@code qva.ts}）の既定と同じ 1.5。 */
    public static final double DEFAULT_ANEURYSM_RATIO = 1.5;
}
