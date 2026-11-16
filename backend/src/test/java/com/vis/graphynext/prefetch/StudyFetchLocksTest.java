/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StudyFetchLocksTest {

    @Test
    void sameStudyIsSerialised_differentStudiesAreNot_andLocksAreCleanedUp() throws Exception {
        AtomicInteger inside = new AtomicInteger();
        AtomicInteger maxInside = new AtomicInteger();
        CountDownLatch go = new CountDownLatch(1);
        Runnable same = () -> StudyFetchLocks.withLock("1.2.3", () -> {
            int n = inside.incrementAndGet();
            maxInside.accumulateAndGet(n, Math::max);
            try {
                go.await(2, TimeUnit.SECONDS);
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            inside.decrementAndGet();
            return null;
        });
        Thread a = new Thread(same);
        Thread b = new Thread(same);
        a.start();
        b.start();
        Thread.sleep(100);
        go.countDown();
        a.join(5000);
        b.join(5000);
        assertEquals(1, maxInside.get(), "同じ検査は、同時に 2 つ入れない");

        // 別の検査は待たせない: 1 つ目の中で、別の検査のロックが取れる
        String r = StudyFetchLocks.withLock("1.2.4", () -> StudyFetchLocks.withLock("1.2.5", () -> "ok"));
        assertEquals("ok", r);
        assertEquals(0, StudyFetchLocks.size(), "使い終わったロックが残っている");
    }

    @Test
    void releasesTheLockWhenTheBodyThrows() {
        try {
            StudyFetchLocks.withLock("9.9", () -> {
                throw new IllegalStateException("x");
            });
        } catch (IllegalStateException expected) {
            // 投げても、ロックは放される
        }
        assertEquals("again", StudyFetchLocks.withLock("9.9", () -> "again"));
        assertTrue(StudyFetchLocks.size() == 0);
    }
}
