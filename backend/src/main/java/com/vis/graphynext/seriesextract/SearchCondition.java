/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import com.vis.graphynext.extract.TagExtractService.Seg;

import java.util.List;

/**
 * シリーズ抽出の 1 条件（GRAPHY SearchCondition 移植）。
 *
 * @param segments タグパス（中間 SQ→末尾値。{@link Seg}）
 * @param vr       末尾タグの VR（比較方法の切替に使用。DS/IS/.. 数値、DA/DT/TM 日時、その他 文字列）
 * @param exclude  true=Exclude(OR: どれか一致で除外) / false=Include(AND: 全て一致必須)
 * @param op       EQUALS | CONTAINS | GE | LE | RANGE
 * @param value1   比較値（RANGE の下限）
 * @param value2   RANGE の上限（その他は未使用）
 */
public record SearchCondition(
        List<Seg> segments,
        String vr,
        boolean exclude,
        String op,
        String value1,
        String value2) {
}
