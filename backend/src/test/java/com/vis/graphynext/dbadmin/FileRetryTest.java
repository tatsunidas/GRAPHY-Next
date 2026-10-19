/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.nio.file.AccessDeniedException;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 一時的な失敗だけをやり直し、永続的な失敗はすぐ諦める。待ちは実際には眠らない。 */
class FileRetryTest {

    @TempDir
    Path tmp;

    final List<Long> slept = new ArrayList<>();
    final FileRetry retry = new FileRetry(ms -> slept.add(ms));

    @Test
    void 一時的な失敗が2回続いても_3回目で成功する() throws Exception {
        AtomicInteger n = new AtomicInteger();
        String r = retry.run("x", tmp, () -> {
            if (n.incrementAndGet() < 3) {
                throw new AccessDeniedException("locked");
            }
            return "ok";
        });
        assertEquals("ok", r);
        assertEquals(3, n.get());
        assertEquals(List.of(250L, 750L), slept, "待ちは 250ms → 750ms");
    }

    @Test
    void 上限を超えたら最後の例外を投げ_待ちも有界() {
        AtomicInteger n = new AtomicInteger();
        assertThrows(AccessDeniedException.class, () -> retry.run("x", tmp, () -> {
            n.incrementAndGet();
            throw new AccessDeniedException("locked");
        }));
        assertEquals(FileRetry.MAX_ATTEMPTS, n.get());
        assertEquals(2, slept.size());
        assertTrue(slept.stream().mapToLong(Long::longValue).sum() <= 1_000, "合計の待ちは 1 秒前後");
    }

    @Test
    void 永続的な失敗はやり直さない() {
        for (IOException permanent : new IOException[] {
                new NoSuchFileException("gone"),
                new IOException("DICOM として読めない"),
                new FileSystemException("a", null, "No space left on device"),
                new FileSystemException("a", null, "Disk quota exceeded"),
                new FileNotFoundException("存在しないファイル")}) {
            AtomicInteger n = new AtomicInteger();
            assertThrows(IOException.class, () -> retry.run("x", tmp.resolve("無い"), () -> {
                n.incrementAndGet();
                throw permanent;
            }));
            assertEquals(1, n.get(), permanent.toString());
        }
        assertTrue(slept.isEmpty(), "永続的な失敗では待たない");
    }

    @Test
    void 掴まれているだけの失敗_共有違反_は一時的() throws Exception {
        Path f = tmp.resolve("a.dcm");
        Files.writeString(f, "x");
        assertTrue(FileRetry.isTransient(new FileSystemException(f.toString(), null, "The process cannot access the file because it is being used by another process"), f));
        assertTrue(FileRetry.isTransient(new FileNotFoundException("(別のプロセスが使用中)"), f), "実在するのに開けない FileNotFoundException");
        assertFalse(FileRetry.isTransient(new FileNotFoundException("無い"), tmp.resolve("無い.dcm")));
    }

    @Test
    void 待っている間に割り込まれたら_すぐ失敗にして割り込みを保つ() {
        FileRetry interrupting = new FileRetry(ms -> {
            throw new InterruptedException();
        });
        assertThrows(InterruptedIOException.class, () -> interrupting.run("x", tmp, () -> {
            throw new AccessDeniedException("locked");
        }));
        assertTrue(Thread.interrupted(), "割り込みの印を戻す（上位が止まれるように）");
    }
}
