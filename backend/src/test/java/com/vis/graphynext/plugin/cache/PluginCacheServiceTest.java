/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.cache;

import com.vis.graphynext.cache.CacheStore;
import com.vis.graphynext.plugin.spi.PluginCache;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

class PluginCacheServiceTest {

    private static PluginCacheService svc(Path dir, long max) {
        return new PluginCacheService(new CacheStore(dir, 0), max);
    }

    private static List<String> names(Path dir) throws IOException {
        try (Stream<Path> s = Files.list(dir)) { return s.map(p -> p.getFileName().toString()).toList(); }
    }

    @Test
    void defaultItemLimitIs16MiB() {
        assertEquals(16L * 1024 * 1024, PluginCacheService.DEFAULT_MAX_ITEM_BYTES);
    }

    @Test
    void roundTrip_overwrite_remove(@TempDir Path dir) {
        PluginCacheService c = svc(dir, 1024);
        assertEquals(PluginCacheService.Outcome.OK, c.put("a", "k", new byte[] {1, 2, 3}));
        assertArrayEquals(new byte[] {1, 2, 3}, c.get("a", "k").orElseThrow());
        assertTrue(c.has("a", "k"));

        c.put("a", "k", new byte[] {9});
        assertArrayEquals(new byte[] {9}, c.get("a", "k").orElseThrow(), "上書き");

        c.remove("a", "k");
        assertFalse(c.has("a", "k"));
        assertTrue(c.get("a", "k").isEmpty());
    }

    @Test
    void emptyPayloadIsStoredAndRead(@TempDir Path dir) {
        PluginCacheService c = svc(dir, 1024);
        assertEquals(PluginCacheService.Outcome.OK, c.put("a", "empty", new byte[0]));
        assertEquals(0, c.get("a", "empty").orElseThrow().length);
    }

    @Test
    void pluginsCannotSeeOrDeleteEachOthersItems(@TempDir Path dir) {
        PluginCacheService c = svc(dir, 1024);
        c.put("a", "same-key", new byte[] {1});
        c.put("b", "same-key", new byte[] {2});

        assertArrayEquals(new byte[] {1}, c.get("a", "same-key").orElseThrow());
        assertArrayEquals(new byte[] {2}, c.get("b", "same-key").orElseThrow());
        c.remove("b", "same-key");
        assertTrue(c.has("a", "same-key"), "b が消しても a の項目は残る");
        assertTrue(c.get("c", "same-key").isEmpty());
    }

    @Test
    void keyAndPluginIdNeverAppearInFileNames(@TempDir Path dir) throws IOException {
        PluginCacheService c = svc(dir, 1024);
        c.put("my-plugin", "patient^NAME/12345", new byte[] {1});
        c.saveCheckpoint("my-plugin", "job-patient^NAME", 3, new byte[] {1});
        for (String n : names(dir)) {
            assertFalse(n.contains("NAME") || n.contains("12345") || n.contains("my-plugin"), n);
        }
        assertEquals(2, names(dir).size());
    }

    @Test
    void invalidKeysAreRejected(@TempDir Path dir) {
        PluginCacheService c = svc(dir, 1024);
        assertEquals(PluginCacheService.Outcome.INVALID_KEY, c.put("a", null, new byte[1]));
        assertEquals(PluginCacheService.Outcome.INVALID_KEY, c.put("a", "", new byte[1]));
        assertEquals(PluginCacheService.Outcome.INVALID_KEY, c.put("a", "x".repeat(257), new byte[1]));
        assertEquals(PluginCacheService.Outcome.INVALID_KEY, c.put("a", "bad\nkey", new byte[1]));
        assertEquals(PluginCacheService.Outcome.OK, c.put("a", "x".repeat(256), new byte[1]));
        assertEquals(PluginCacheService.Outcome.OK, c.put("a", "日本語/鍵 ../", new byte[1]), "経路を含む文字列も名前には影響しない");
    }

    @Test
    void oversizedItemIsRejectedAndLeavesNothing(@TempDir Path dir) throws IOException {
        PluginCacheService c = svc(dir, 8);
        assertEquals(PluginCacheService.Outcome.OK, c.put("a", "ok", new byte[8]));
        assertEquals(PluginCacheService.Outcome.TOO_LARGE, c.put("a", "big", new byte[9]));
        assertEquals(PluginCacheService.Outcome.TOO_LARGE, c.saveCheckpoint("a", "job", 0, new byte[9]));
        assertTrue(c.get("a", "big").isEmpty());
        assertEquals(1, names(dir).size());
    }

    @Test
    void oversizedOverwriteKeepsThePreviousValue(@TempDir Path dir) {
        PluginCacheService c = svc(dir, 8);
        c.put("a", "k", new byte[] {7});
        c.put("a", "k", new byte[9]);
        assertArrayEquals(new byte[] {7}, c.get("a", "k").orElseThrow());
    }

    @Test
    void corruptedFileIsTreatedAsAbsent(@TempDir Path dir) throws IOException {
        PluginCacheService c = svc(dir, 1024);
        c.put("a", "k", new byte[] {1, 2, 3, 4});
        Path f;
        try (Stream<Path> s = Files.list(dir)) { f = s.findFirst().orElseThrow(); }
        byte[] raw = Files.readAllBytes(f);
        Files.write(f, java.util.Arrays.copyOf(raw, raw.length - 1));
        assertTrue(new PluginCacheService(new CacheStore(dir, 0), 1024).get("a", "k").isEmpty());
    }

    @Test
    void checkpointsAreIndependentPerJobAndClearOnlyThatJob(@TempDir Path dir) {
        PluginCacheService c = svc(dir, 1024);
        for (int i = 0; i < 3; i++) {
            c.saveCheckpoint("a", "job1", i, new byte[] {(byte) i});
            c.saveCheckpoint("a", "job2", i, new byte[] {(byte) (10 + i)});
            c.saveCheckpoint("b", "job1", i, new byte[] {(byte) (20 + i)});
        }
        c.put("a", "job1", new byte[] {99}); // 同じ文字列でも項目とチェックポイントは別

        c.clearCheckpoints("a", "job1");

        for (int i = 0; i < 3; i++) {
            assertTrue(c.loadCheckpoint("a", "job1", i).isEmpty());
            assertArrayEquals(new byte[] {(byte) (10 + i)}, c.loadCheckpoint("a", "job2", i).orElseThrow());
            assertArrayEquals(new byte[] {(byte) (20 + i)}, c.loadCheckpoint("b", "job1", i).orElseThrow());
        }
        assertArrayEquals(new byte[] {99}, c.get("a", "job1").orElseThrow(), "項目は残る");
    }

    @Test
    void checkpointIndexRange(@TempDir Path dir) {
        PluginCacheService c = svc(dir, 1024);
        assertEquals(PluginCacheService.Outcome.INVALID_INDEX, c.saveCheckpoint("a", "j", -1, new byte[1]));
        assertEquals(PluginCacheService.Outcome.INVALID_INDEX, c.saveCheckpoint("a", "j", 1_000_000, new byte[1]));
        assertEquals(PluginCacheService.Outcome.OK, c.saveCheckpoint("a", "j", 999_999, new byte[1]));
        assertTrue(c.loadCheckpoint("a", "j", -5).isEmpty());
    }

    @Test
    void jarFacadeIsBoundToThePluginAndReturnsValuesNotExceptions(@TempDir Path dir) {
        PluginCacheService c = svc(dir, 8);
        PluginCache jar = c.forPlugin("a");
        assertTrue(jar.put("k", new byte[] {1}));
        assertFalse(jar.put("big", new byte[9]), "大きすぎは false");
        assertFalse(jar.put(null, new byte[1]), "不正な鍵は false");
        assertNull(jar.get("none"));
        assertTrue(jar.has("k"));
        assertTrue(c.has("a", "k"));
        assertFalse(c.has("b", "k"));

        PluginCache.Checkpoint cp = jar.checkpoint("job");
        assertTrue(cp.save(0, new byte[] {5}));
        assertArrayEquals(new byte[] {5}, cp.load(0));
        assertNull(cp.load(1));
        cp.clear();
        assertNull(cp.load(0));
        jar.remove("k");
        assertFalse(jar.has("k"));
    }

    @Test
    void survivesRestart(@TempDir Path dir) {
        svc(dir, 1024).saveCheckpoint("a", "job", 2, new byte[] {4, 5});
        assertArrayEquals(new byte[] {4, 5}, svc(dir, 1024).loadCheckpoint("a", "job", 2).orElseThrow());
    }
}
