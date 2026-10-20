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
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

class CacheStoreTest {

    /** 進めた分だけ時刻が進む時計（LRU の順序を決定的にする）。 */
    private static final class TickClock extends Clock {
        final AtomicLong now = new AtomicLong(1_000);
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId z) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(now.get()); }
        @Override public long millis() { return now.get(); }
        void tick() { now.addAndGet(10); }
    }

    private static CacheStore.Producer bytes(int n) {
        return tmp -> Files.write(tmp, new byte[n]);
    }

    private static List<String> names(Path dir) throws IOException {
        try (var s = Files.list(dir)) {
            return s.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    // ── 基本 ──────────────────────────────────────────────────────────────

    @Test
    void createsOnce_thenReuses(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 0);
        AtomicInteger made = new AtomicInteger();
        CacheStore.Producer p = tmp -> { made.incrementAndGet(); Files.write(tmp, new byte[5]); };

        Path a = c.getOrCreate("a.v2.mp4", f -> true, p);
        Path b = c.getOrCreate("a.v2.mp4", f -> true, p);

        assertEquals(a, b);
        assertEquals(1, made.get(), "2 回目は生成しない");
        assertEquals(5, Files.size(a));
    }

    @Test
    void invalidEntryIsRegenerated(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 0);
        c.getOrCreate("a.mp4", f -> true, tmp -> Files.write(tmp, new byte[3]));

        Path again = c.getOrCreate("a.mp4", f -> false, tmp -> Files.write(tmp, new byte[7]));

        assertEquals(7, Files.size(again), "valid が偽なら作り直す");
    }

    @Test
    void versionInNameIsSeparateEntry(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 0);
        c.getOrCreate("x.v1.mp4", f -> true, bytes(3));
        c.getOrCreate("x.v2.mp4", f -> true, bytes(4));
        assertEquals(List.of("x.v1.mp4", "x.v2.mp4"), names(dir));
    }

    @Test
    void tempFileKeepsFinalExtension(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 0);
        List<String> seen = new ArrayList<>();
        c.getOrCreate("a.v2.mp4", f -> true, tmp -> { seen.add(tmp.getFileName().toString()); Files.write(tmp, new byte[1]); });
        assertTrue(seen.get(0).startsWith(CacheStore.TMP_PREFIX) && seen.get(0).endsWith(".mp4"), seen.get(0));
    }

    @Test
    void rejectsBadNames(@TempDir Path dir) {
        CacheStore c = new CacheStore(dir, 0);
        for (String bad : new String[] {"", "../x", "a/b", "a\\b", "..", CacheStore.TMP_PREFIX + "x"}) {
            assertThrows(IllegalArgumentException.class, () -> c.getOrCreate(bad, f -> true, bytes(1)), bad);
        }
    }

    // ── 原子性 ────────────────────────────────────────────────────────────

    @Test
    void failedProducerLeavesNothing(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 0);
        assertThrows(IOException.class, () -> c.getOrCreate("a.mp4", f -> true, tmp -> {
            Files.write(tmp, new byte[100]); // 書きかけ
            throw new IOException("boom");
        }));
        assertEquals(List.of(), names(dir), "最終名も一時ファイルも残らない");
        assertEquals(0, c.entryCount());
    }

    @Test
    void failedProducerKeepsPreviousGoodEntry(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 0);
        c.getOrCreate("a.mp4", f -> true, tmp -> Files.write(tmp, new byte[3]));
        assertThrows(IOException.class, () -> c.getOrCreate("a.mp4", f -> false, tmp -> {
            Files.write(tmp, new byte[9]);
            throw new IOException("boom");
        }));
        assertEquals(3, Files.size(dir.resolve("a.mp4")), "作り直しに失敗しても前の中身は壊れない");
    }

    @Test
    void emptyOutputIsRejected(@TempDir Path dir) {
        CacheStore c = new CacheStore(dir, 0);
        assertThrows(IOException.class, () -> c.getOrCreate("a.mp4", f -> true, tmp -> { }));
        assertFalse(Files.exists(dir.resolve("a.mp4")));
    }

    @Test
    void reopenSweepsLeftoverTempFiles(@TempDir Path dir) throws IOException {
        Files.write(dir.resolve(CacheStore.TMP_PREFIX + "123.mp4"), new byte[50]); // kill された生成の残骸
        Files.write(dir.resolve("keep.mp4"), new byte[4]);

        CacheStore c = new CacheStore(dir, 0);

        assertEquals(List.of("keep.mp4"), names(dir));
        assertEquals(1, c.entryCount());
        assertEquals(4, c.totalBytes());
    }

    // ── 並行 ──────────────────────────────────────────────────────────────

    @Test
    void sameKeyIsProducedOnce(@TempDir Path dir) throws Exception {
        CacheStore c = new CacheStore(dir, 0);
        AtomicInteger made = new AtomicInteger();
        int n = 8;
        ExecutorService ex = Executors.newFixedThreadPool(n);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Path>> fs = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            fs.add(ex.submit(() -> {
                go.await();
                return c.getOrCreate("k.mp4", f -> true, tmp -> {
                    made.incrementAndGet();
                    try { Thread.sleep(150); } catch (InterruptedException e) { throw new IOException(e); }
                    Files.write(tmp, new byte[2]);
                });
            }));
        }
        go.countDown();
        for (Future<Path> f : fs) f.get(10, TimeUnit.SECONDS);
        ex.shutdown();
        assertEquals(1, made.get(), "同じキーの同時要求は 1 回だけ生成する");
    }

    @Test
    void differentKeysDoNotBlockEachOther(@TempDir Path dir) throws Exception {
        CacheStore c = new CacheStore(dir, 0);
        CountDownLatch aStarted = new CountDownLatch(1);
        CountDownLatch releaseA = new CountDownLatch(1);
        ExecutorService ex = Executors.newFixedThreadPool(2);
        Future<Path> a = ex.submit(() -> c.getOrCreate("a.mp4", f -> true, tmp -> {
            aStarted.countDown();
            try { releaseA.await(10, TimeUnit.SECONDS); } catch (InterruptedException e) { throw new IOException(e); }
            Files.write(tmp, new byte[1]);
        }));
        assertTrue(aStarted.await(5, TimeUnit.SECONDS));
        // a が生成中のまま、b は完了できる
        Path b = ex.submit(() -> c.getOrCreate("b.mp4", f -> true, bytes(1))).get(5, TimeUnit.SECONDS);
        assertTrue(Files.exists(b));
        assertFalse(a.isDone());
        releaseA.countDown();
        a.get(5, TimeUnit.SECONDS);
        ex.shutdown();
    }

    // ── 上限・LRU ─────────────────────────────────────────────────────────

    @Test
    void evictsLeastRecentlyUsedFirst(@TempDir Path dir) throws IOException {
        TickClock clock = new TickClock();
        CacheStore c = new CacheStore(dir, 25, clock);
        c.getOrCreate("a", f -> true, bytes(10)); clock.tick();
        c.getOrCreate("b", f -> true, bytes(10)); clock.tick();
        c.getOrCreate("a", f -> true, bytes(10)); clock.tick(); // a を読み直す → b が最古
        c.getOrCreate("c", f -> true, bytes(10));                // 合計 30 > 25 → b が消える

        assertEquals(List.of("a", "c"), names(dir));
        assertEquals(20, c.totalBytes());
    }

    @Test
    void neverEvictsTheEntryJustCreated(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 5, new TickClock());
        Path big = c.getOrCreate("big", f -> true, bytes(50)); // 単独で上限超過
        assertTrue(Files.exists(big), "今作った項目は上限超過でも消さない");
    }

    @Test
    void zeroMeansUnlimited(@TempDir Path dir) throws IOException {
        TickClock clock = new TickClock();
        CacheStore c = new CacheStore(dir, 0, clock);
        for (int i = 0; i < 5; i++) { c.getOrCreate("k" + i, f -> true, bytes(1000)); clock.tick(); }
        assertEquals(5, names(dir).size());
    }

    @Test
    void unremovableEntryIsSkipped(@TempDir Path dir) throws IOException {
        TickClock clock = new TickClock();
        CacheStore c = new CacheStore(dir, 15, clock);
        // 最古の項目をフォルダにすり替えて「消せない」状態を作る（空でないフォルダは deleteIfExists が失敗する）
        c.getOrCreate("old", f -> true, bytes(10)); clock.tick();
        Files.delete(dir.resolve("old"));
        Files.createDirectory(dir.resolve("old"));
        Files.write(dir.resolve("old").resolve("x"), new byte[10]);
        c.getOrCreate("mid", f -> true, bytes(10)); clock.tick();
        c.getOrCreate("new", f -> true, bytes(10));

        assertTrue(Files.exists(dir.resolve("old")), "消せない項目は残る");
        assertFalse(Files.exists(dir.resolve("mid")), "消せない項目を飛ばして次に古いものを消す");
        assertTrue(Files.exists(dir.resolve("new")));
    }

    @Test
    void reopenRebuildsIndexFromDisk(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 0);
        c.getOrCreate("a", f -> true, bytes(7));
        c.getOrCreate("b", f -> true, bytes(9));

        CacheStore again = new CacheStore(dir, 0);

        assertEquals(2, again.entryCount());
        assertEquals(16, again.totalBytes());
    }

    @Test
    void removeDeletesEntry(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 0);
        c.getOrCreate("a", f -> true, bytes(7));
        assertTrue(c.remove("a"));
        assertEquals(0, c.entryCount());
        assertTrue(c.remove("a"), "無いものを消すのは成功扱い");
    }

    @Test
    void removeByPrefixRemovesOnlyMatchingEntries(@TempDir Path dir) throws IOException {
        CacheStore c = new CacheStore(dir, 0);
        for (String n : new String[] {"ab.1", "ab.2", "abc.1", "b.1"}) c.getOrCreate(n, f -> true, bytes(1));
        assertEquals(2, c.removeByPrefix("ab."));
        assertEquals(List.of("abc.1", "b.1"), names(dir));
        assertEquals(2, c.entryCount());
        assertThrows(IllegalArgumentException.class, () -> c.removeByPrefix(""));
        assertThrows(IllegalArgumentException.class, () -> c.removeByPrefix("../x"));
    }
}
