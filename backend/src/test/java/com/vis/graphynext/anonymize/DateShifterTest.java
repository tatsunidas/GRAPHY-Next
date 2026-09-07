/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 日付シフト（Modified Dates Option・113107）の単体テスト（Spring 不要）。
 *
 * <p>🔴 <b>なぜこれを書いたか</b>: 従来はアクション C が VR 別の固定ダミーを返すだけで元の値を
 * 読んでおらず、<b>全検査日が {@code 20000101} に潰れて</b>いた（2026-08-20 実測。
 * 元 {@code 20260101} と {@code 20260730} の 2 スタディが両方 {@code 20000101}）。
 * それでいて 113107（＝時間的前後関係を保持したという申告）を宣言していた。
 *
 * <p>既存テストは {@code AnonymizeEngineTest} の「StudyDate が C になること」＝<b>辞書引きの
 * 正しさだけ</b>を見ており、C を適用した結果どんな値になるかを検証していなかったので素通りした。
 */
class DateShifterTest {

    private static final long SEED = 20260907L;

    @Test
    void shiftDaysFor_sameSeedAndPatient_isStable() {
        assertEquals(DateShifter.shiftDaysFor("PID123", SEED), DateShifter.shiftDaysFor("PID123", SEED),
                "同じ種と同じ患者なら常に同じオフセット");
    }

    @Test
    void shiftDaysFor_differentSeed_givesDifferentOffset() {
        assertNotEquals(DateShifter.shiftDaysFor("PID123", SEED), DateShifter.shiftDaysFor("PID123", SEED + 1),
                "種が違えばオフセットも変わる");
    }

    @Test
    void shiftDaysFor_isAlwaysInThePast_andWithinTenYears() {
        for (int i = 0; i < 2000; i++) {
            int d = DateShifter.shiftDaysFor("PID" + i, SEED);
            assertTrue(d < 0, "未来日を作らないよう常に過去方向: " + d);
            assertTrue(d >= -DateShifter.MAX_SHIFT_DAYS, "10 年を超えない: " + d);
        }
    }

    @Test
    void shiftDaysFor_isIndependentOfProcessingOrder() {
        // 🔴 java.util.Random を順に引く実装への回帰。buildPatientMappings は randomSeed が
        // あると患者の並びをシャッフルするので、順序に依存すると「後日その患者だけ追加で
        // エクスポートしたら日付が別方向にずれた」という事故になる。
        List<String> ids = new ArrayList<>(List.of("A", "B", "C", "D", "E"));
        List<Integer> first = ids.stream().map(id -> DateShifter.shiftDaysFor(id, SEED)).toList();
        Collections.shuffle(ids);
        for (String id : ids) {
            assertEquals(first.get(List.of("A", "B", "C", "D", "E").indexOf(id)),
                    DateShifter.shiftDaysFor(id, SEED), "並び順を変えても同じ患者は同じオフセット");
        }
    }

    @Test
    void shiftDa_preservesIntervalBetweenStudies() {
        // fw/mainscreen-tools.md L146 の実測ケースそのもの。
        int shift = DateShifter.shiftDaysFor("PID123", SEED);
        String a = DateShifter.shiftDa("20260101", shift);
        String b = DateShifter.shiftDa("20260730", shift);

        assertNotEquals("20000101", a, "固定ダミーに潰れない");
        assertNotEquals("20000101", b, "固定ダミーに潰れない");
        assertNotEquals(a, b, "別々の日付が同じ日に潰れない");

        DateTimeFormatter f = DateTimeFormatter.ofPattern("yyyyMMdd");
        long days = LocalDate.parse(b, f).toEpochDay() - LocalDate.parse(a, f).toEpochDay();
        assertEquals(210, days, "元の 210 日差がそのまま保たれる（＝時間的前後関係の保持）");
    }

    @Test
    void shiftDa_multiValued_shiftsEveryValue() {
        String out = DateShifter.shiftDa("20260101\\20260102", -1);
        assertEquals("20251231\\20260101", out, "多値は各値を個別にシフトする");
    }

    @Test
    void shiftDt_shiftsDatePart_keepsTimeAndTimezone() {
        assertEquals("20251231101530.123456+0900", DateShifter.shiftDt("20260101101530.123456+0900", -1),
                "日付部だけずらし、時刻・小数秒・タイムゾーンは残す");
    }

    @Test
    void shiftDt_dateOnlyValue_isStillShifted() {
        assertEquals("20251231", DateShifter.shiftDt("20260101", -1), "DT は時刻部が無くても妥当");
    }

    @Test
    void shift_invalidInput_returnsNull_neverTheOriginal() {
        // 🔴 「ずらせなかったから元のまま素通し」は最悪の漏洩経路。呼び出し元が空にできるよう null。
        assertNull(DateShifter.shiftDa("not-a-date", -1));
        assertNull(DateShifter.shiftDa("20261301", -1), "13 月は不正");
        assertNull(DateShifter.shiftDa("20260230", -1), "2 月 30 日は不正");
        assertNull(DateShifter.shiftDa("202601", -1), "桁数不足");
        assertNull(DateShifter.shiftDa(null, -1));
        assertNull(DateShifter.shiftDa("   ", -1));
        assertNull(DateShifter.shiftDt("2026", -1));
        assertNull(DateShifter.shiftDa("20260101\\bogus", -1), "多値の 1 つでも壊れていたら値ごと捨てる");
    }

    @Test
    void shiftDa_crossesLeapDay_correctly() {
        assertEquals("20240229", DateShifter.shiftDa("20240301", -1), "うるう日をまたいでも日数が正しい");
    }
}
