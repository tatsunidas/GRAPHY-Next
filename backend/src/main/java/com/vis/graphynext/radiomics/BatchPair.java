/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.util.List;

/**
 * 一括抽出の 1 組（元画像シリーズ × SEG のセグメント 1 つ）。患者名・患者 ID は持たない。
 *
 * @param maskChannel      {@link RoiFeatureRequest#maskChannel()} に渡す値。セグメント番号ではなく、
 *                         前景のあるセグメントを番号の昇順に並べたときの添字（0 始まり）
 * @param status           {@code AUTO}＝SEG が参照する元画像を機械的に特定できた。
 *                         {@code NEEDS_CONFIRMATION}＝特定できない（候補は {@code sourceCandidates}）。
 *                         {@code EXCLUDED}＝実行できない（理由は {@code reason}）
 * @param sourceSeriesUid  元画像シリーズ。{@code NEEDS_CONFIRMATION} のときは利用者が選んで埋める
 */
public record BatchPair(
        String studyUid,
        String sourceSeriesUid,
        String maskSeriesUid,
        Integer segmentNumber,
        String segmentLabel,
        int maskChannel,
        Status status,
        String reason,
        List<String> sourceCandidates) {

    public enum Status { AUTO, NEEDS_CONFIRMATION, EXCLUDED }

    /** 組を識別するキー。画面の {@code pairKey} と同じ並び（QC で許容した組の照合に使う）。 */
    @com.fasterxml.jackson.annotation.JsonIgnore
    public String pairKey() {
        return studyUid + "|" + maskSeriesUid + "|" + maskChannel;
    }

    static BatchPair excluded(String studyUid, String maskSeriesUid, Integer segmentNumber, String segmentLabel,
                              String reason) {
        return new BatchPair(studyUid, null, maskSeriesUid, segmentNumber, segmentLabel, 0, Status.EXCLUDED, reason,
                List.of());
    }
}
