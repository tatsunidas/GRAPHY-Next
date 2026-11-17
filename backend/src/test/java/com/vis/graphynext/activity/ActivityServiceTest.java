/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;

class ActivityServiceTest {

    /** 件数と中止の呼ばれ方を持つ偽の処理。 */
    private static final class Fake implements ActiveWork {
        final String kind;
        final boolean cancellable;
        final AtomicInteger active;
        final AtomicInteger cancelCalls = new AtomicInteger();
        RuntimeException failCount;
        RuntimeException failCancel;

        Fake(String kind, int active, boolean cancellable) {
            this.kind = kind;
            this.active = new AtomicInteger(active);
            this.cancellable = cancellable;
        }

        @Override public String kind() { return kind; }
        @Override public int activeCount() {
            if (failCount != null) throw failCount;
            return active.get();
        }
        @Override public void cancelAll() {
            cancelCalls.incrementAndGet();
            if (failCancel != null) throw failCancel;
            active.set(0);
        }
        @Override public boolean cancellable() { return cancellable; }
    }

    @Test
    void snapshotListsOnlyKindsWithActiveWorkAndInFlightRequests() {
        InFlightRequests inFlight = new InFlightRequests();
        inFlight.enter("send");
        ActivityService s = new ActivityService(
                List.of(new Fake("export", 2, true), new Fake("import", 0, true), new Fake("qrRetrieve", 1, false)), inFlight);
        List<ActivityService.Item> items = s.snapshot();
        assertEquals(
                List.of(new ActivityService.Item("export", 2, true),
                        new ActivityService.Item("qrRetrieve", 1, false),
                        new ActivityService.Item("send", 1, false)),
                items);
    }

    @Test
    void nothingRunningMeansEmptySnapshot() {
        ActivityService s = new ActivityService(List.of(new Fake("export", 0, true)), new InFlightRequests());
        assertTrue(s.snapshot().isEmpty());
    }

    @Test
    void cancelAllCancelsOnlyActiveCancellableWork() {
        Fake running = new Fake("export", 1, true);
        Fake idle = new Fake("import", 0, true);
        Fake noCancel = new Fake("qrRetrieve", 1, false);
        ActivityService s = new ActivityService(List.of(running, idle, noCancel), new InFlightRequests());
        assertTrue(s.cancelAll().isEmpty());
        assertEquals(1, running.cancelCalls.get());
        assertEquals(0, idle.cancelCalls.get(), "動いていないものには触らない");
        assertEquals(0, noCancel.cancelCalls.get(), "中止の口が無いものは呼ばない");
        assertEquals(List.of(new ActivityService.Item("qrRetrieve", 1, false)), s.snapshot());
    }

    @Test
    void oneFailingCancelDoesNotStopTheOthers() {
        Fake bad = new Fake("export", 1, true);
        bad.failCancel = new IllegalStateException("boom");
        Fake good = new Fake("import", 1, true);
        ActivityService s = new ActivityService(List.of(bad, good), new InFlightRequests());
        assertEquals(List.of("export"), s.cancelAll());
        assertEquals(1, good.cancelCalls.get(), "失敗した種類のあとも、残りは中止する");
    }

    @Test
    void aCountThatCannotBeReadIsShownAsOneNotZero() {
        Fake broken = new Fake("export", 0, true);
        broken.failCount = new IllegalStateException("boom");
        ActivityService s = new ActivityService(List.of(broken), new InFlightRequests());
        List<ActivityService.Item> items = s.snapshot();
        assertEquals(1, items.size(), "数えられないものを 0 件として見せない（終了前の確認で見落とさない）");
        assertEquals(1, items.get(0).count());
    }

    @Test
    void inFlightCountsGoUpAndDownAndNeverGoNegative() {
        InFlightRequests r = new InFlightRequests();
        r.enter("send");
        r.enter("send");
        assertEquals(2, r.snapshot().get("send"));
        r.exit("send");
        r.exit("send");
        r.exit("send"); // 余計な exit
        assertFalse(r.snapshot().containsKey("send"));
    }
}
