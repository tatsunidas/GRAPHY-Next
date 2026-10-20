/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.compute.ComputeJobStateMachine.Reason;
import com.vis.graphynext.compute.ComputeJobStateMachine.State;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ComputeJobLedgerTest {

    @TempDir
    Path dir;
    InMemoryComputeJobStore store;
    ComputeJobLedger ledger;

    @BeforeEach
    void setUp() {
        store = new InMemoryComputeJobStore();
        ledger = new ComputeJobLedger(store, new ObjectMapper(), dir.resolve("jobs"),
                Clock.fixed(Instant.parse("2026-10-20T00:00:00Z"), ZoneOffset.UTC),
                id -> new ComputeJobLedger.PluginFacts("Seg", "1.2.3", null));
    }

    static ComputeEgressService.EgressRequest request() {
        return new ComputeEgressService.EgressRequest("egr_1", "seg", "Seg", "local", "Local", "http://127.0.0.1:8888/",
                false, "local", List.of(), "print(1)", "abc", "anon", "v1-hash", Instant.now(),
                ComputeEgressService.Status.CONSUMED);
    }

    String queued() {
        return ledger.create(request(), List.of(new ComputeJobLedger.InputRef("1.2.3", "1.2.3.4", "npz"),
                new ComputeJobLedger.InputRef("1.2.9", "1.2.9.9", "dicom-zip")), 600);
    }

    @Test
    void createsAQueuedRowThatKeepsEverythingNeededToRerun() {
        String id = queued();
        ComputeJobRecord j = ledger.find(id).orElseThrow();
        ComputeBatchRecord b = ledger.batchOf(j).orElseThrow();
        assertEquals("QUEUED", j.state);
        assertEquals("print(1)", b.code);
        assertEquals("abc", b.codeSha256);
        assertEquals("1.2.3", b.pluginVersion);
        assertNull(b.pluginPackageSha256, "台帳に無いプラグインの SHA-256 は不明（null）のまま");
        assertEquals("127.0.0.1:8888", b.endpointHost);
        assertEquals(2, ledger.inputsOf(j).size());
        assertEquals("egr_1", j.requestId);
    }

    @Test
    void theLedgerHasNoPatientColumns() {
        for (Class<?> c : List.of(ComputeBatchRecord.class, ComputeJobRecord.class)) {
            for (Field f : c.getDeclaredFields()) {
                String n = f.getName().toLowerCase();
                assertFalse(n.contains("patient") || n.contains("birth") || n.contains("description"),
                        "🔴 患者情報の列は作らない: " + c.getSimpleName() + "." + f.getName());
            }
        }
    }

    @Test
    void walksQueuedRunningDone() {
        String id = queued();
        assertTrue(ledger.start(id, "graphy/abc"));
        ledger.progress(id, "upload", 0.1, "upload");
        ComputeJobRecord j = ledger.find(id).orElseThrow();
        assertEquals("RUNNING", j.state);
        assertEquals("upload", j.phase);
        assertEquals("graphy/abc", j.remoteRunDir);
        ledger.finish(id, State.DONE, null, null, null, 42);
        j = ledger.find(id).orElseThrow();
        assertEquals("DONE", j.state);
        assertEquals(1.0, j.progress);
        assertEquals(42, j.outputsBytes);
        assertNotNull(j.finishedAt);
        assertThrows(IllegalStateException.class, () -> ledger.finish(id, State.FAILED, Reason.INTERNAL, null, null, 0),
                "終わった行は動かせない");
    }

    @Test
    void aQueuedCancelBeatsTheStart_andOnlyOneOfThemWins() {
        String id = queued();
        assertTrue(ledger.cancelIfQueued(id));
        assertFalse(ledger.start(id, null), "🔴 待ちの間に中止された行は始まらない");
        assertFalse(ledger.cancelIfQueued(id), "二重の中止は何もしない");
        assertEquals("CANCELLED", ledger.find(id).orElseThrow().state);

        String running = queued();
        assertTrue(ledger.start(running, null));
        assertFalse(ledger.cancelIfQueued(running), "始まった行は待ちの中止では止めない");
        assertEquals("RUNNING", ledger.find(running).orElseThrow().state);
    }

    @Test
    void failureKeepsTheReasonAndTruncatesTheErrorValue() {
        String id = queued();
        ledger.start(id, null);
        ledger.finish(id, State.FAILED, Reason.CODE_ERROR, "OutOfMemoryError", "x".repeat(1000), 0);
        ComputeJobRecord j = ledger.find(id).orElseThrow();
        assertEquals("code-error", j.reason);
        assertEquals("OutOfMemoryError", j.errorName);
        assertEquals(ComputeJobRecord.ERROR_VALUE_MAX, j.errorValue.length());
    }

    @Test
    void progressIsWrittenWhenThePhaseChangesOrMovesEnough_notOnEveryTick() {
        String id = queued();
        ledger.start(id, null);
        ledger.progress(id, "exec", 0.20, "a");
        ledger.progress(id, "exec", 0.21, "b"); // 小さな動き・同じ段・同じ秒＝書かない
        assertEquals("a", ledger.find(id).orElseThrow().message);
        ledger.progress(id, "exec", 0.30, "c"); // 0.05 以上
        assertEquals("c", ledger.find(id).orElseThrow().message);
        ledger.progress(id, "download", 0.301, "d"); // 段が変わった
        assertEquals("d", ledger.find(id).orElseThrow().message);
    }

    @Test
    void recoversInterruptedRows_andMarksRemoteCleanupPendingOnlyWhereAFolderWasMade() {
        String waiting = queued();
        String running = queued();
        String done = queued();
        ledger.start(running, "graphy/run1");
        ledger.start(done, "graphy/run2");
        ledger.finish(done, State.DONE, null, null, null, 0);

        assertEquals(2, ledger.recoverInterrupted());
        ComputeJobRecord w = ledger.find(waiting).orElseThrow();
        ComputeJobRecord r = ledger.find(running).orElseThrow();
        assertEquals("INTERRUPTED", w.state);
        assertEquals("interrupted", w.reason);
        assertNull(w.remoteCleanup, "作業フォルダが無い行は後始末が要らない");
        assertEquals("INTERRUPTED", r.state);
        assertEquals("pending", r.remoteCleanup);
        assertEquals("DONE", ledger.find(done).orElseThrow().state, "終わった行は触らない");
        assertEquals(List.of(running), ledger.cleanupPending().stream().map(x -> x.id).toList());
        assertEquals(0, ledger.recoverInterrupted(), "二度目は何もしない");
    }

    @Test
    void forgetsTheUidsOfADeletedSeries() {
        String id = queued();
        assertTrue(ledger.find(id).orElseThrow().inputRefs.contains("1.2.3.4"), "🔴 先に、消す前は値があることを確かめる");
        assertEquals(1, ledger.clearSeries(List.of("1.2.3.4")));
        List<ComputeJobLedger.InputRef> now = ledger.inputsOf(ledger.find(id).orElseThrow());
        assertEquals("", now.get(0).seriesUid());
        assertEquals("", now.get(0).studyUid());
        assertEquals("npz", now.get(0).format(), "形式は残す");
        assertEquals("1.2.9.9", now.get(1).seriesUid(), "別のシリーズは残す");
        assertFalse(ledger.find(id).orElseThrow().inputRefs.contains("1.2.3.4"));
        @SuppressWarnings("unchecked")
        var view = (List<java.util.Map<String, Object>>) ledger.view(ledger.find(id).orElseThrow()).get("inputs");
        assertEquals(true, view.get(0).get("deleted"));
        assertEquals(false, view.get(1).get("deleted"));
    }

    @Test
    void logsAreFilesInTheJobFolder_andDeleteRemovesRowAndFolder() throws Exception {
        String id = queued();
        ledger.start(id, null);
        ledger.writeLogs(id, "out", "", "Traceback…");
        assertEquals("out", ledger.readLog(id, "stdout").orElseThrow());
        assertEquals("", ledger.readLog(id, "stderr").orElseThrow(), "空のログは空文字");
        assertEquals("Traceback…", ledger.readLog(id, "traceback").orElseThrow());
        assertTrue(ledger.readLog(id, "../x").isEmpty(), "種類は 3 つだけ");
        assertThrows(IllegalStateException.class, () -> ledger.delete(id), "実行中の行は消せない");
        ledger.finish(id, State.DONE, null, null, null, 0);
        ledger.delete(id);
        assertTrue(ledger.find(id).isEmpty());
        assertFalse(Files.exists(ledger.jobDir(id)));
        assertThrows(IllegalArgumentException.class, () -> ledger.jobDir("../etc"));
    }

    @Test
    void theListIsNewestFirstAndCarriesNoPatientInformation() {
        String a = queued();
        String view = ledger.view(ledger.find(a).orElseThrow()).toString().toLowerCase();
        assertFalse(view.contains("patient"), view);
        assertEquals(1, ledger.list().size());
    }
}
