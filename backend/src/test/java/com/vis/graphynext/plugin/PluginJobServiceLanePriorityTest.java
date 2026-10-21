/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 計算機ごとの列の優先: 実行中は止めず、待ちのうち対話のジョブを低優先（一括の組）より先に取る。 */
class PluginJobServiceLanePriorityTest {

    private static PluginJobService service() {
        PluginRegistry none = (PluginRegistry) Proxy.newProxyInstance(PluginJobServiceLanePriorityTest.class.getClassLoader(),
                new Class<?>[]{PluginRegistry.class}, (p, m, a) -> {
                    throw new UnsupportedOperationException(m.getName());
                });
        return new PluginJobService(none, new PluginArtifacts());
    }

    private static PluginJobService.Task task(String name, List<String> order, CountDownLatch gate, CountDownLatch started) {
        return ctx -> {
            if (started != null) {
                started.countDown();
            }
            if (gate != null) {
                gate.await(30, TimeUnit.SECONDS);
            }
            order.add(name);
            return name;
        };
    }

    private static void await(PluginJobService s, String jobId) throws InterruptedException {
        for (int i = 0; i < 300 && !s.status(jobId).orElseThrow().ended(); i++) {
            Thread.sleep(50);
        }
        assertTrue(s.status(jobId).orElseThrow().ended());
    }

    @Test
    void interactiveJobsGoBeforeWaitingLowPriorityOnesButNeverStopTheRunningOne() throws Exception {
        PluginJobService s = service();
        List<String> order = new CopyOnWriteArrayList<>();
        CountDownLatch gate = new CountDownLatch(1);
        CountDownLatch started = new CountDownLatch(1);
        PluginJobService.Status running = s.submitSerialTaskLow("lane", "p", task("running-low", order, gate, started));
        assertTrue(started.await(10, TimeUnit.SECONDS));
        PluginJobService.Status low2 = s.submitSerialTaskLow("lane", "p", task("low2", order, null, null));
        PluginJobService.Status low3 = s.submitSerialTaskLow("lane", "p", task("low3", order, null, null));
        PluginJobService.Status hi = s.submitSerialTask("lane", "p", task("interactive", order, null, null));
        gate.countDown();
        for (PluginJobService.Status st : List.of(running, low2, low3, hi)) {
            await(s, st.jobId());
        }
        assertEquals(List.of("running-low", "interactive", "low2", "low3"), order,
                "🔴 実行中は止めず、次は対話のジョブ、そのあと低優先を並べた順に");
    }

    @Test
    void anotherLaneIsNotAffected() throws Exception {
        PluginJobService s = service();
        List<String> order = new CopyOnWriteArrayList<>();
        CountDownLatch gate = new CountDownLatch(1);
        CountDownLatch started = new CountDownLatch(1);
        PluginJobService.Status blocked = s.submitSerialTaskLow("a", "p", task("a-blocked", order, gate, started));
        assertTrue(started.await(10, TimeUnit.SECONDS));
        PluginJobService.Status other = s.submitSerialTaskLow("b", "p", task("b-runs", order, null, null));
        await(s, other.jobId());
        assertEquals(List.of("b-runs"), order, "別の計算機の列は待たない");
        gate.countDown();
        await(s, blocked.jobId());
    }
}
