/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.compute.ComputeJobStateMachine.State;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 台帳が実際の H2（ddl-auto: update で表を作る）に保存・読み出しできること。コードの全文は CLOB 列。 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:computeledger;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ComputeJobLedgerPersistenceTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
        r.add("graphy.compute.jobs-dir", () -> tmp.resolve("compute-jobs").toString());
    }

    @Autowired
    ComputeJobLedger ledger;

    private static ComputeEgressService.EgressRequest request(String code) {
        return new ComputeEgressService.EgressRequest("egr_p", "seg", "Seg", "local", "Local", "http://127.0.0.1:8888/",
                false, "local", List.of(), code, "sha", "anon", "v1", Instant.now(), ComputeEgressService.Status.CONSUMED);
    }

    @Test
    void roundTripsThroughH2_includingALongCodeAndTheSeriesLookup() {
        String code = "print('x')\n".repeat(20_000); // 約 220KB。VARCHAR には入らない大きさ
        String id = ledger.create(request(code), List.of(new ComputeJobLedger.InputRef("9.9.1", "9.9.1.7", "npz")), 600);
        assertTrue(ledger.start(id, "graphy/run"));
        ledger.finish(id, State.FAILED, ComputeJobStateMachine.Reason.CODE_ERROR, "ValueError", "bad", 7);

        ComputeJobRecord j = ledger.find(id).orElseThrow();
        assertEquals("FAILED", j.state);
        assertEquals("code-error", j.reason);
        assertEquals(7, j.outputsBytes);
        assertEquals(code, ledger.batchOf(j).orElseThrow().code, "コードの全文が欠けずに戻る");
        assertTrue(ledger.list().stream().anyMatch(x -> x.id.equals(id)));

        assertEquals(1, ledger.clearSeries(List.of("9.9.1.7")), "H2 の部分一致でシリーズの UID から行を引ける");
        assertEquals("", ledger.inputsOf(ledger.find(id).orElseThrow()).get(0).seriesUid());

        ledger.delete(id);
        assertTrue(ledger.find(id).isEmpty());
    }

    @Test
    void recoversRowsLeftRunning() {
        String id = ledger.create(request("print(1)"), List.of(), 60);
        ledger.start(id, "graphy/left-over");
        assertTrue(ledger.recoverInterrupted() >= 1);
        ComputeJobRecord j = ledger.find(id).orElseThrow();
        assertEquals("INTERRUPTED", j.state);
        assertEquals("pending", j.remoteCleanup);
    }
}
