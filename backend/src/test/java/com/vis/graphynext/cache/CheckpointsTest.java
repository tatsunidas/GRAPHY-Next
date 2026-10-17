/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.cache;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.*;

class CheckpointsTest {

    private static final String KEY = "0123456789abcdef0123456789abcdef";

    private static Path file(Path dir, int index) {
        return dir.resolve(KEY + "." + String.format("%06d", index) + ".ckpt");
    }

    @Test
    void roundTrip_andSurvivesReopen(@TempDir Path dir) {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        byte[] data = {1, 2, 3, 4, 5, 6, 7, 8};
        assertTrue(c.save(KEY, 3, data));

        assertArrayEquals(data, c.load(KEY, 3, 8).orElseThrow());
        assertArrayEquals(data, new Checkpoints(new CacheStore(dir, 0)).load(KEY, 3, 8).orElseThrow(), "再起動後も読める");
        assertTrue(c.load(KEY, 4, 8).isEmpty(), "保存していない添字は無い");
    }

    @Test
    void wrongLengthIsTreatedAsAbsent(@TempDir Path dir) {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        c.save(KEY, 0, new byte[8]);
        assertTrue(c.load(KEY, 0, 12).isEmpty(), "期待する長さと違えば無いものとして扱う");
    }

    @Test
    void corruptHeaderIsTreatedAsAbsent_andOverwritable(@TempDir Path dir) throws IOException {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        byte[] data = new byte[8];
        Arrays.fill(data, (byte) 9);
        c.save(KEY, 0, data);
        byte[] raw = Files.readAllBytes(file(dir, 0));
        raw[0] ^= 0x7f; // マジックを壊す（長さは変わらない）
        Files.write(file(dir, 0), raw);

        assertTrue(new Checkpoints(new CacheStore(dir, 0)).load(KEY, 0, 8).isEmpty());
        assertTrue(c.save(KEY, 0, data), "壊れた項目は上書きで直る");
        assertArrayEquals(data, c.load(KEY, 0, 8).orElseThrow());
    }

    @Test
    void truncatedFileIsTreatedAsAbsent(@TempDir Path dir) throws IOException {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        c.save(KEY, 0, new byte[64]);
        byte[] raw = Files.readAllBytes(file(dir, 0));
        Files.write(file(dir, 0), Arrays.copyOf(raw, raw.length - 5));
        assertTrue(c.load(KEY, 0, 64).isEmpty());
    }

    @Test
    void clearRemovesOnlyThatJob(@TempDir Path dir) {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        String other = "fedcba9876543210fedcba9876543210";
        for (int i = 0; i < 3; i++) { c.save(KEY, i, new byte[4]); c.save(other, i, new byte[4]); }

        c.clear(KEY, 3);

        for (int i = 0; i < 3; i++) {
            assertTrue(c.load(KEY, i, 4).isEmpty());
            assertTrue(c.load(other, i, 4).isPresent(), "別のジョブは残る");
        }
    }

    @Test
    void rejectsUnsafeJobKey(@TempDir Path dir) {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        assertThrows(IllegalArgumentException.class, () -> c.save("../evil", 0, new byte[4]));
        assertThrows(IllegalArgumentException.class, () -> c.load("a/b/c/d/e/f/g/h", 0, 4));
    }

    @Test
    void variableLengthRoundTrip_andTruncationIsAbsent(@TempDir Path dir) throws IOException {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        byte[] data = "{\"a\":1}".getBytes();
        assertTrue(c.save(KEY, 0, data));
        assertArrayEquals(data, c.load(KEY, 0).orElseThrow());
        assertArrayEquals(new byte[0], saveAndLoad(c, new byte[0]));

        assertTrue(c.save(KEY, 0, data));
        byte[] raw = Files.readAllBytes(file(dir, 0));
        Files.write(file(dir, 0), Arrays.copyOf(raw, raw.length - 1));
        assertTrue(c.load(KEY, 0).isEmpty());
        raw[0] ^= 0x7f;
        Files.write(file(dir, 0), raw);
        assertTrue(c.load(KEY, 0).isEmpty());
    }

    private static byte[] saveAndLoad(Checkpoints c, byte[] data) {
        assertTrue(c.save(KEY, 1, data));
        return c.load(KEY, 1).orElseThrow();
    }
}
