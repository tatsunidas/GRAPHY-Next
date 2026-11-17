/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.compute.ComputeJobStateMachine.State;
import com.vis.graphynext.plugin.PluginArtifacts;
import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/** 終了前の「いま走っている処理」（ActiveWork）: 計算ジョブ。数えるのは QUEUED と RUNNING だけ。 */
class ComputeJobRunnerActiveWorkTest {

    @TempDir
    Path dir;

    private String state(ComputeJobLedger ledger, String id) {
        return ledger.find(id).orElseThrow().state;
    }

    @Test
    void 待ちと実行中だけを数え_cancelAllで止まり_操作待ちと終了済みは数えず触らない() throws Exception {
        InMemoryComputeJobStore store = new InMemoryComputeJobStore();
        ComputeJobLedger ledger = new ComputeJobLedger(store, new ObjectMapper(), dir.resolve("jobs"), Clock.systemUTC(),
                id -> new ComputeJobLedger.PluginFacts("Seg", "1.0.0", null));
        PluginJobService jobs = new PluginJobService(mock(PluginRegistry.class), new PluginArtifacts());
        ComputeJobRunner runner = new ComputeJobRunner(mock(ComputeEgressService.class),
                mock(ComputeEndpointRegistry.class), mock(ComputeDatasetService.class), mock(ComputeAuditLog.class),
                jobs, new ObjectMapper(), ledger);
        assertEquals("compute", runner.kind());
        assertTrue(runner.cancellable());
        assertEquals(0, runner.activeCount(), "何も無いとき");
        runner.cancelAll();

        // 実行中: 本物のジョブの仕組み（PluginJobService）に乗せ、中止を見て台帳を CANCELLED にする（run と同じ流れ）
        String running = ComputeJobLedgerTest.queuedIn(ledger);
        assertTrue(ledger.start(running, "graphy/r"));
        CountDownLatch started = new CountDownLatch(1);
        PluginJobService.Status st = jobs.submitSerialTask("lab", "seg", new PluginJobService.Task() {
            @Override
            public Object run(PluginJobService.TaskContext ctx) {
                started.countDown();
                while (!ctx.cancelled().getAsBoolean()) {
                    Thread.onSpinWait();
                }
                ledger.finish(running, State.CANCELLED, null, null, null, 0);
                return null;
            }
        });
        ledger.attachPluginJob(running, st.jobId());
        assertTrue(started.await(5, TimeUnit.SECONDS));

        // 順番待ち（計算機へ何も送っていない）
        String queued = ComputeJobLedgerTest.queuedIn(ledger);
        // 利用者の操作待ち（数えない）
        String awaiting = ComputeJobLedgerTest.queuedIn(ledger);
        assertTrue(ledger.start(awaiting, "graphy/a"));
        ComputeJobRecord a = store.findJob(awaiting).orElseThrow();
        a.state = State.AWAITING_USER.name();
        store.saveJob(a);
        // 終了済み（数えない）
        String done = ComputeJobLedgerTest.queuedIn(ledger);
        assertTrue(ledger.start(done, "graphy/d"));
        ledger.finish(done, State.DONE, null, null, null, 1);

        assertEquals(2, runner.activeCount(), "RUNNING 1 + QUEUED 1。AWAITING_USER と DONE は数えない");

        runner.cancelAll();

        for (int i = 0; i < 250 && runner.activeCount() > 0; i++) {
            Thread.sleep(20);
        }
        assertEquals(0, runner.activeCount());
        assertEquals("CANCELLED", state(ledger, running));
        assertEquals("CANCELLED", state(ledger, queued));
        assertEquals("AWAITING_USER", state(ledger, awaiting), "操作待ちは触らない");
        assertEquals("DONE", state(ledger, done), "終了済みは触らない");
    }
}
