/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** 派生シリーズの SeriesNumber: 元 + 1000 から始め、検査内の既存番号と重ならない最小の番号にする。 */
class DerivedSeriesNumberTest {

    @Test
    void usesTheBaseWhenFree() {
        assertEquals(1002, DerivedSeriesService.nextFreeSeriesNumber(1002, Set.of(1, 2)));
        assertEquals(1000, DerivedSeriesService.nextFreeSeriesNumber(1000, Set.of()));
    }

    @Test
    void movesToTheNextFreeNumberWhenTheBaseIsTaken() {
        assertEquals(1003, DerivedSeriesService.nextFreeSeriesNumber(1002, Set.of(1, 2, 1002)));
        assertEquals(1005, DerivedSeriesService.nextFreeSeriesNumber(1002, Set.of(1002, 1003, 1004)));
    }

    @Test
    void skipsOnlyTheTakenNumbersAndLeavesGapsBelowTheBase() {
        // 1003 が空いていれば、1002・1004 が使用中でも 1003 を返す（base 以上で最小の空き）。
        assertEquals(1003, DerivedSeriesService.nextFreeSeriesNumber(1002, Set.of(1002, 1004)));
    }

    @Test
    void neverReturnsAUsedNumber() {
        Set<Integer> used = new HashSet<>(Set.of(1, 2));
        for (int i = 0; i < 20; i++) {
            int n = DerivedSeriesService.nextFreeSeriesNumber(1002, used);
            assertFalse(used.contains(n));
            used.add(n); // 連続して保存すると 1002, 1003, ... と連番になる
            assertEquals(1002 + i, n);
        }
    }
}
