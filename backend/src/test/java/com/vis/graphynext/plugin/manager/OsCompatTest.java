/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** {@link OsCompat}: プラグインの対応 OS と実行中 OS の突き合わせ。 */
class OsCompatTest {

    @Test
    void mapsJavaOsNameToPlatformToken() {
        assertEquals("win32", OsCompat.fromOsName("Windows 11"));
        assertEquals("win32", OsCompat.fromOsName("Windows Server 2022"));
        assertEquals("darwin", OsCompat.fromOsName("Mac OS X"));
        assertEquals("linux", OsCompat.fromOsName("Linux"));
        assertEquals("unknown", OsCompat.fromOsName(""));
    }

    @Test
    void normalizesManifestAliases() {
        assertEquals("win32", OsCompat.normalize("windows"));
        assertEquals("win32", OsCompat.normalize(" Win "));
        assertEquals("darwin", OsCompat.normalize("macos"));
        assertEquals("darwin", OsCompat.normalize("osx"));
        assertEquals("linux", OsCompat.normalize("Linux"));
    }

    @Test
    void undeclaredMeansOsIndependent() {
        assertTrue(OsCompat.satisfies(null, "linux"));
        assertTrue(OsCompat.satisfies(List.of(), "linux"));
        assertTrue(OsCompat.satisfies(List.of("*"), "linux"));
    }

    @Test
    void matchesDeclaredOsOnly() {
        assertTrue(OsCompat.satisfies(List.of("win32", "linux"), "linux"));
        assertTrue(OsCompat.satisfies(List.of("windows"), "win32")); // 別名でも一致する
        assertFalse(OsCompat.satisfies(List.of("win32", "darwin"), "linux"));
    }

    @Test
    void currentIsOneOfTheKnownTokens() {
        assertTrue(List.of("win32", "darwin", "linux").contains(OsCompat.current()),
                "unexpected platform token: " + OsCompat.current());
    }
}
