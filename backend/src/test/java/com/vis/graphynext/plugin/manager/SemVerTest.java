/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** {@link SemVer} の解釈・比較・互換範囲判定。 */
class SemVerTest {

    @Test
    void parsesLeadingVAndPreRelease() {
        assertTrue(SemVer.parse("v1.2.3").compareTo(SemVer.parse("1.2.3")) == 0);
        assertTrue(SemVer.parse("1.2.3-rc.1").compareTo(SemVer.parse("1.2.3")) == 0);
        assertTrue(SemVer.parse("1.2").compareTo(SemVer.parse("1.2.0")) == 0);
    }

    @Test
    void ordering() {
        assertTrue(SemVer.parse("0.3.0").compareTo(SemVer.parse("0.2.9")) > 0);
        assertTrue(SemVer.parse("1.0.0").compareTo(SemVer.parse("0.99.99")) > 0);
    }

    @Test
    void rangeAnd() {
        assertTrue(SemVer.satisfies("0.2.5", ">=0.2.0 <0.3.0"));
        assertFalse(SemVer.satisfies("0.3.0", ">=0.2.0 <0.3.0"));
        assertFalse(SemVer.satisfies("0.1.9", ">=0.2.0 <0.3.0"));
    }

    @Test
    void singleComparatorsAndExact() {
        assertTrue(SemVer.satisfies("1.2.3", ">=1.0.0"));
        assertTrue(SemVer.satisfies("1.2.3", "1.2.3"));   // 裸＝完全一致
        assertFalse(SemVer.satisfies("1.2.4", "1.2.3"));
        assertTrue(SemVer.satisfies("2.0.0", ">1.9.9"));
    }

    @Test
    void wildcardAndBlankAreAlwaysCompatible() {
        assertTrue(SemVer.satisfies("0.0.1", "*"));
        assertTrue(SemVer.satisfies("0.0.1", ""));
        assertTrue(SemVer.satisfies("0.0.1", null));
    }

    @Test
    void nonSemverCoreIsNotBlocked() {
        // dev ビルド等（"dev"）はゲートしない。
        assertTrue(SemVer.satisfies("dev", ">=0.2.0 <0.3.0"));
    }
}
