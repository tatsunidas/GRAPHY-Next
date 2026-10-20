/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.LayoutTimeAxis.TimeTags;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * T 次元の経過時間（{@link LayoutTimeAxis}）。期待値は実装とは別に、手で決めた時刻から計算する。
 * 迷うとき（欠け・同値・減少・日付なしの日跨ぎ）は null＝秒を作り出さない、を負例で固定する。
 */
class LayoutTimeAxisTest {

    /** nZ スライス × nT 時相の単一フレーム 4D。SOP は "z{z}t{t}"。 */
    private static SeriesLayout layout(int nZ, int nT) {
        List<SeriesLayout.Cell> cells = new ArrayList<>();
        for (int t = 0; t < nT; t++) {
            for (int z = 0; z < nZ; z++) {
                cells.add(new SeriesLayout.Cell(0, z, t, "z" + z + "t" + t));
            }
        }
        return SeriesLayout.noSpatial(nZ, 1, nT, null, nT > 1 ? "Temporal" : null, cells);
    }

    private static Map<String, TimeTags> tags(int nZ, int nT, java.util.function.BiFunction<Integer, Integer, TimeTags> f) {
        Map<String, TimeTags> m = new HashMap<>();
        for (int t = 0; t < nT; t++) {
            for (int z = 0; z < nZ; z++) {
                m.put("z" + z + "t" + t, f.apply(z, t));
            }
        }
        return m;
    }

    private static String tm(double sec) {
        int h = (int) (sec / 3600);
        int m = (int) ((sec - h * 3600) / 60);
        double s = sec - h * 3600 - m * 60;
        return String.format("%02d%02d%09.6f", h, m, s);
    }

    @Test
    void acquisitionTimeGivesPerCellSecondsFromTheFirstAcquisition() {
        // 3 スライス × 4 時相。時相の間隔 5 s、スライスごとに 0.4 s ずつ遅れて取得（DCE の典型）。
        double t0 = 10 * 3600 + 5 * 60 + 30.25; // 100530.25
        SeriesLayout l = layout(3, 4);
        var axis = LayoutTimeAxis.compute(l, tags(3, 4, (z, t) -> new TimeTags("20261020", tm(t0 + 5.0 * t + 0.4 * z), null)));
        assertThat(axis).isNotNull();
        assertThat(axis.source()).isEqualTo("AcquisitionTime");
        for (int t = 0; t < 4; t++) {
            for (int z = 0; z < 3; z++) {
                assertThat(axis.secBySop().get("z" + z + "t" + t)).isCloseTo(5.0 * t + 0.4 * z, org.assertj.core.data.Offset.offset(1e-5));
            }
        }
        // 最小値（z0 t0）が 0。スライスごとの遅れが時相の代表値に潰されていない。
        assertThat(axis.secBySop().get("z0t0")).isEqualTo(0.0);
        assertThat(axis.secBySop().get("z2t0")).isCloseTo(0.8, org.assertj.core.data.Offset.offset(1e-5));
    }

    @Test
    void midnightCrossingIsHandledOnlyWhenTheDateIsPresent() {
        // 23:59:58 → 00:00:02（翌日）。日付があれば 4 s。
        SeriesLayout l = layout(1, 2);
        var withDate = LayoutTimeAxis.compute(l, tags(1, 2, (z, t) ->
                t == 0 ? new TimeTags("20261020", "235958", null) : new TimeTags("20261021", "000002", null)));
        assertThat(withDate).isNotNull();
        assertThat(withDate.secBySop().get("z0t1")).isCloseTo(4.0, org.assertj.core.data.Offset.offset(1e-9));
        // 日付が無ければ、減少として現れる＝日跨ぎを推測せず不採用（null）。
        var noDate = LayoutTimeAxis.compute(l, tags(1, 2, (z, t) ->
                new TimeTags(null, t == 0 ? "235958" : "000002", null)));
        assertThat(noDate).isNull();
    }

    @Test
    void triggerTimeIsUsedWhenThereIsNoAcquisitionTime() {
        // NIfTI 由来: TriggerTime = TR×t（ms）。TR = 2.5 s。
        SeriesLayout l = layout(2, 5);
        var axis = LayoutTimeAxis.compute(l, tags(2, 5, (z, t) -> new TimeTags(null, null, 2500.0 * t)));
        assertThat(axis).isNotNull();
        assertThat(axis.source()).isEqualTo("TriggerTime");
        for (int t = 0; t < 5; t++) {
            assertThat(axis.secBySop().get("z1t" + t)).isCloseTo(2.5 * t, org.assertj.core.data.Offset.offset(1e-9));
        }
    }

    @Test
    void acquisitionTimeWinsOverTriggerTime() {
        SeriesLayout l = layout(1, 3);
        var axis = LayoutTimeAxis.compute(l, tags(1, 3, (z, t) -> new TimeTags("20261020", tm(36000 + 10.0 * t), 1000.0 * t)));
        assertThat(axis.source()).isEqualTo("AcquisitionTime");
        assertThat(axis.secBySop().get("z0t2")).isCloseTo(20.0, org.assertj.core.data.Offset.offset(1e-6));
    }

    @Test
    void fallsBackToTriggerWhenAcquisitionTimeIsUnusableButTriggerIsFine() {
        // AcquisitionTime が全て同じ（使えない）→ TriggerTime へ。
        SeriesLayout l = layout(1, 3);
        var axis = LayoutTimeAxis.compute(l, tags(1, 3, (z, t) -> new TimeTags("20261020", "100000", 3000.0 * t)));
        assertThat(axis).isNotNull();
        assertThat(axis.source()).isEqualTo("TriggerTime");
    }

    // ── 負例: 迷うときは null（秒を作り出さない） ───────────────────

    @Test
    void singleTimePointHasNoTimeAxis() {
        assertThat(LayoutTimeAxis.compute(layout(3, 1), tags(3, 1, (z, t) -> new TimeTags("20261020", "100000", 0.0)))).isNull();
    }

    @Test
    void equalOrDecreasingTimesAreRefused() {
        SeriesLayout l = layout(1, 3);
        assertThat(LayoutTimeAxis.compute(l, tags(1, 3, (z, t) -> new TimeTags("20261020", "100000", null)))).as("全て同じ").isNull();
        assertThat(LayoutTimeAxis.compute(l, tags(1, 3, (z, t) -> new TimeTags("20261020", tm(36000 - 5.0 * t), null)))).as("減る").isNull();
        assertThat(LayoutTimeAxis.compute(l, tags(1, 3, (z, t) -> new TimeTags("20261020", tm(36000 + (t == 2 ? 5.0 : 5.0 * t)), null)))).as("同じ値がある").isNull();
    }

    @Test
    void oneMissingCellRefusesTheWholeSourceInsteadOfFillingIt() {
        SeriesLayout l = layout(2, 3);
        Map<String, TimeTags> m = tags(2, 3, (z, t) -> new TimeTags("20261020", tm(36000 + 5.0 * t + z), null));
        m.put("z1t1", new TimeTags("20261020", null, null)); // 1 セルだけ時刻が無い
        assertThat(LayoutTimeAxis.compute(l, m)).isNull();
        m.remove("z0t0"); // タグ自体が無いセル
        assertThat(LayoutTimeAxis.compute(l, m)).isNull();
    }

    @Test
    void mixedDateAndNoDateIsRefused() {
        SeriesLayout l = layout(1, 2);
        assertThat(LayoutTimeAxis.compute(l, tags(1, 2, (z, t) -> new TimeTags(t == 0 ? "20261020" : null, tm(36000 + 5.0 * t), null)))).isNull();
    }

    @Test
    void malformedTimeStringsAreTreatedAsMissing() {
        SeriesLayout l = layout(1, 2);
        for (String bad : new String[] {"", "abc", "25", "126100", "10:61:00", "1000.5x", "1", "10 00"}) {
            assertThat(LayoutTimeAxis.compute(l, tags(1, 2, (z, t) -> new TimeTags(null, t == 0 ? "100000" : bad, null)))).as(bad).isNull();
        }
        // 旧形式のコロン付きと桁欠けは読める（正例）。
        assertThat(LayoutTimeAxis.parseTimeOfDay("10:00:05")).isEqualTo(36005.0);
        assertThat(LayoutTimeAxis.parseTimeOfDay("1000")).isEqualTo(36000.0);
        assertThat(LayoutTimeAxis.parseTimeOfDay("10")).isEqualTo(36000.0);
        assertThat(LayoutTimeAxis.parseTimeOfDay("100000.25")).isEqualTo(36000.25);
        assertThat(LayoutTimeAxis.parseEpochDay("20261340")).isNull();
    }

    @Test
    void oneSopSpanningSeveralTimePointsIsNotSupported() {
        // 1 SOP のフレームが時相を作る（XA・NM のマルチフレーム）。SOP 単位の時刻では区別できない。
        List<SeriesLayout.Cell> cells = List.of(new SeriesLayout.Cell(0, 0, 0, "a", 0), new SeriesLayout.Cell(0, 0, 1, "a", 1),
                new SeriesLayout.Cell(0, 0, 2, "b", 0));
        SeriesLayout l = SeriesLayout.noSpatial(1, 1, 3, null, "Temporal", cells);
        Map<String, TimeTags> m = new HashMap<>();
        m.put("a", new TimeTags("20261020", "100000", null));
        m.put("b", new TimeTags("20261020", "100010", null));
        assertThat(LayoutTimeAxis.compute(l, m)).isNull();
    }

    @Test
    void mosaicWhereOneSopHoldsSeveralSlicesOfTheSameTimePointIsSupported() {
        // Siemens モザイク: 1 SOP ＝ 同じ時相の 2 スライス（タイル）。時相ごとに SOP が違う。
        List<SeriesLayout.Cell> cells = List.of(
                new SeriesLayout.Cell(0, 0, 0, "m0", 0), new SeriesLayout.Cell(0, 1, 0, "m0", 1),
                new SeriesLayout.Cell(0, 0, 1, "m1", 0), new SeriesLayout.Cell(0, 1, 1, "m1", 1));
        SeriesLayout l = SeriesLayout.noSpatial(2, 1, 2, null, "Temporal", cells);
        Map<String, TimeTags> m = new HashMap<>();
        m.put("m0", new TimeTags("20261020", "100000", null));
        m.put("m1", new TimeTags("20261020", "100003", null));
        var axis = LayoutTimeAxis.compute(l, m);
        assertThat(axis).isNotNull();
        assertThat(axis.secBySop().get("m1")).isCloseTo(3.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void layoutWithTimeAxisKeepsEverythingElse() {
        SeriesLayout l = layout(2, 3);
        var axis = new SeriesLayout.TimeAxis("TriggerTime", Map.of("z0t0", 0.0));
        SeriesLayout w = l.withTimeAxis(axis);
        assertThat(w.timeAxis()).isSameAs(axis);
        assertThat(w.nZ()).isEqualTo(l.nZ());
        assertThat(w.cells()).isEqualTo(l.cells());
        assertThat(l.timeAxis()).isNull(); // 元は変わらない
    }
}
