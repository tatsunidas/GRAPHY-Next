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
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Random;

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

    @Test
    void clearAllRemovesEveryIndexOfThatJobOnly(@TempDir Path dir) {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        String other = "fedcba9876543210fedcba9876543210";
        for (int i : new int[] {0, 5, 999}) { c.save(KEY, i, new byte[4]); c.save(other, i, new byte[4]); }
        assertEquals(3, c.clearAll(KEY));
        for (int i : new int[] {0, 5, 999}) {
            assertTrue(c.load(KEY, i).isEmpty());
            assertTrue(c.load(other, i).isPresent());
        }
    }

    // ---- 版 2: 中身のチェックサム ----

    /** 本体の途中の 1 ビットを反転する（長さ・ヘッダは変わらない）。 */
    private static void flipBodyBit(Path f, int bodyOffset) throws IOException {
        byte[] raw = Files.readAllBytes(f);
        raw[16 + bodyOffset] ^= 0x01;
        Files.write(f, raw);
    }

    @Test
    void aFlippedBitInTheBody_isDetected_theFileIsRemoved_andItIsRepairable(@TempDir Path dir) throws IOException {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        byte[] data = new byte[64];
        new Random(1).nextBytes(data);
        for (boolean fixedLength : new boolean[] {true, false}) {
            assertTrue(c.save(KEY, 0, data));
            flipBodyBit(file(dir, 0), 17);

            assertTrue((fixedLength ? c.load(KEY, 0, 64) : c.load(KEY, 0)).isEmpty(), "化けた本体は返さない");
            assertFalse(Files.exists(file(dir, 0)), "化けたファイルは消える");
            assertTrue(c.save(KEY, 0, data), "消えたあとは保存し直せる");
            assertArrayEquals(data, (fixedLength ? c.load(KEY, 0, 64) : c.load(KEY, 0)).orElseThrow());
        }
    }

    @Test
    void aFlippedBitInTheChecksum_isDetected(@TempDir Path dir) throws IOException {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        c.save(KEY, 0, new byte[]{1, 2, 3, 4});
        byte[] raw = Files.readAllBytes(file(dir, 0));
        raw[raw.length - 1] ^= 0x01;
        Files.write(file(dir, 0), raw);
        assertTrue(c.load(KEY, 0, 4).isEmpty());
        assertTrue(c.load(KEY, 0).isEmpty());
    }

    @Test
    void aVersion1FileCannotBeVerified_soItIsAbsent_andIsReplacedBySaving(@TempDir Path dir) throws IOException {
        byte[] body = {9, 8, 7, 6};
        // チェックサムなしの旧形式（版 1）を手で組み立てる
        ByteBuffer v1 = ByteBuffer.allocate(16 + body.length);
        v1.putInt(0x47434b50).putInt(1).putLong(body.length).put(body);
        Files.write(file(dir, 0), v1.array());

        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        assertTrue(c.load(KEY, 0, 4).isEmpty(), "版 1 は検証できないので使わない");
        assertTrue(c.load(KEY, 0).isEmpty());
        assertTrue(Files.exists(file(dir, 0)), "版 1 のファイルは消さない（保存し直されるまで残る）");

        assertTrue(c.save(KEY, 0, body));
        assertArrayEquals(body, c.load(KEY, 0, 4).orElseThrow(), "保存し直すと版 2 で読める");
    }

    @Test
    void emptyAndLargeBodiesRoundTrip(@TempDir Path dir) {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        assertTrue(c.save(KEY, 0, new byte[0]));
        assertArrayEquals(new byte[0], c.load(KEY, 0).orElseThrow());
        assertArrayEquals(new byte[0], c.load(KEY, 0, 0).orElseThrow());

        byte[] big = new byte[1 << 20];
        new Random(7).nextBytes(big);
        assertTrue(c.save(KEY, 1, big));
        assertArrayEquals(big, c.load(KEY, 1, big.length).orElseThrow());
        assertArrayEquals(big, new Checkpoints(new CacheStore(dir, 0)).load(KEY, 1).orElseThrow(), "再起動後も読める");
    }

    /**
     * 実測用（通常は走らせない）: {@code -Dcheckpoints.measure=true} のときだけ、本体の大きさごとに、
     * 照合つきの {@code load} と、ファイルを読むだけ（照合なしの下限）の時間を標準出力に出す。
     */
    @Test
    @org.junit.jupiter.api.condition.EnabledIfSystemProperty(named = "checkpoints.measure", matches = "true")
    void measureLoadTime(@TempDir Path dir) throws IOException {
        Checkpoints c = new Checkpoints(new CacheStore(dir, 0));
        for (int mb : new int[] {1, 16, 64}) {
            byte[] data = new byte[mb << 20];
            new Random(mb).nextBytes(data);
            assertTrue(c.save(KEY, mb, data));
            long[] withDigest = new long[7];
            long[] readOnly = new long[7];
            for (int i = 0; i < 7; i++) {
                long t0 = System.nanoTime();
                assertEquals(data.length, c.load(KEY, mb, data.length).orElseThrow().length);
                withDigest[i] = System.nanoTime() - t0;
                t0 = System.nanoTime();
                assertTrue(Files.readAllBytes(file(dir, mb)).length > data.length);
                readOnly[i] = System.nanoTime() - t0;
            }
            Arrays.sort(withDigest);
            Arrays.sort(readOnly);
            System.out.println("MEASURE bodyMB=" + mb + " loadWithDigestMsMedian=" + withDigest[3] / 1_000_000.0
                    + " readOnlyMsMedian=" + readOnly[3] / 1_000_000.0);
        }
    }
}
