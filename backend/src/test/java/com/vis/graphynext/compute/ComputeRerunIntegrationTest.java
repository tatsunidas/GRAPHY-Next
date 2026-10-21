/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.plugin.PluginArtifacts;
import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginManifest;
import com.vis.graphynext.plugin.PluginRegistry;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 再実行の通し（本物の jupyter_server。{@code GRAPHY_JUPYTER_PYTHON} が無ければ skip）。
 * 失敗した組だけを、新しい要求・新しい承認で、同じバッチの次の試行として走らせる。
 */
class ComputeRerunIntegrationTest {

    private static LocalJupyter jupyter;

    @TempDir
    Path dir;

    private DatasetFixture fx;
    private ComputeDatasetService datasets;
    private ComputeEgressService egress;
    private ComputeJobRunner runner;
    private ComputeJobLedger ledger;
    private ComputeRerunController rerun;

    @BeforeAll
    static void startJupyter() throws Exception {
        jupyter = LocalJupyter.start();
    }

    @AfterAll
    static void stopJupyter() {
        if (jupyter != null) {
            jupyter.close();
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        fx = new DatasetFixture(dir);
        fx.writeCtSeries();
        ComputeEndpointRegistry endpoints = new ComputeEndpointRegistry();
        endpoints.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("local", "Local", jupyter.url, jupyter.token)));
        datasets = fx.service();
        ComputeAuditLog audit = new ComputeAuditLog(dir.resolve("audit.jsonl").toString(), fx.mapper);
        egress = new ComputeEgressService(endpoints, datasets, audit);
        PluginRegistry plugins = (PluginRegistry) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{PluginRegistry.class}, (p, m, a) -> {
                    if (m.getName().equals("manifests")) {
                        return List.of(new PluginManifest("seg", "Seg", "1.0.0", null, null, List.of("remote-compute"), null));
                    }
                    throw new UnsupportedOperationException(m.getName());
                });
        PluginJobService jobs = new PluginJobService(plugins, new PluginArtifacts());
        ledger = new ComputeJobLedger(new InMemoryComputeJobStore(), fx.mapper, dir.resolve("compute-jobs"),
                java.time.Clock.systemUTC(), id -> new ComputeJobLedger.PluginFacts("Seg", "1.0.0", null));
        runner = new ComputeJobRunner(egress, endpoints, datasets, audit, jobs, fx.mapper, ledger);
        rerun = new ComputeRerunController(plugins, endpoints, datasets, egress, runner, ledger);
    }

    private ComputeEgressService.EgressRequest approvedBatch(String code, String... keys) {
        LinkedHashMap<String, List<String>> items = new LinkedHashMap<>();
        for (String k : keys) {
            items.put(k, List.of(datasets.create(DatasetFixture.STUDY, DatasetFixture.CT_SERIES,
                    ComputeDatasetService.Format.NPZ).handle()));
        }
        ComputeEgressService.EgressRequest r = egress.createBatch("seg", "Seg", "local", items, code, CodeInspector.MAX_JOB_CHARS);
        egress.decide(r.id(), true, r.contentHash()).orElseThrow();
        return r;
    }

    private static void waitUntil(BooleanSupplier c, String what) throws InterruptedException {
        for (int i = 0; i < 1500; i++) {
            if (c.getAsBoolean()) {
                return;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("待っても起きなかった: " + what);
    }

    private boolean allEnded(String batchId) {
        return ledger.jobsOfBatch(batchId).stream().allMatch(j -> ComputeJobStateMachine.State.valueOf(j.state).ended());
    }

    private long count(String needle) throws Exception {
        return Files.readString(dir.resolve("audit.jsonl")).lines().filter(l -> l.contains(needle)).count();
    }

    @SuppressWarnings("unchecked")
    private static <T> T body(ResponseEntity<?> r, String key) {
        return (T) ((Map<String, Object>) r.getBody()).get(key);
    }

    /** 承認して走らせる（main の同意の窓の代わり）。 */
    @SuppressWarnings("unchecked")
    private Map<String, Object> approveAndRun(ResponseEntity<Map<String, Object>> created) {
        assertEquals(HttpStatus.OK, created.getStatusCode(), String.valueOf(created.getBody()));
        String reqId = body(created, "requestId");
        // 承認の前は走らない
        assertEquals(HttpStatus.CONFLICT, rerun.run(new ComputeBatchController.RunBody(reqId, 120)).getStatusCode());
        ComputeEgressService.EgressRequest t = egress.detail(reqId).orElseThrow();
        egress.decide(reqId, true, t.contentHash()).orElseThrow();
        ResponseEntity<?> run = rerun.run(new ComputeBatchController.RunBody(reqId, 120));
        assertEquals(HttpStatus.OK, run.getStatusCode(), String.valueOf(run.getBody()));
        return (Map<String, Object>) run.getBody();
    }

    @Test
    void aFailedItemIsRerunAsTheNextAttemptOfTheSameBatchWithItsOwnApproval() throws Exception {
        Path counter = dir.resolve("counter.txt");
        // 2 組目（n == 1）だけが 1 回目に失敗する。2 回目の実行では n が進んでいるので通る
        String code = "import os\np = r'" + counter.toString().replace("\\", "/") + "'\n"
                + "n = int(open(p).read()) if os.path.exists(p) else 0\nopen(p, 'w').write(str(n + 1))\n"
                + "if n == 1:\n    raise ValueError('second fails')\n";
        ComputeEgressService.EgressRequest first = approvedBatch(code, "a", "b", "c");
        Map<String, Object> submitted = runner.submitBatch("seg", first.id(), 120);
        String batchId = (String) submitted.get("batchId");
        waitUntil(() -> allEnded(batchId), "first run ended");
        assertEquals(2, ledger.jobsOfBatch(batchId).stream().filter(j -> j.state.equals("DONE")).count());
        ComputeJobRecord failed = ledger.jobsOfBatch(batchId).stream().filter(j -> j.state.equals("FAILED")).findFirst().orElseThrow();
        assertEquals("b", failed.itemKey);
        assertEquals(1, failed.attempt);

        // 失敗だけ再実行: 新しい要求（新しい id）・新しい承認が要る
        ResponseEntity<Map<String, Object>> created = rerun.rerunFailed(batchId, null);
        assertNotEquals(first.id(), body(created, "requestId"), "🔴 前の承認は使い回さない");
        assertEquals(HttpStatus.CONFLICT, rerun.run(new ComputeBatchController.RunBody(first.id(), 120)).getStatusCode(),
                "🔴 最初の承認（使用済み）で再実行は走らない");
        Map<String, Object> started = approveAndRun(created);
        assertEquals(batchId, started.get("batchId"), "同じ一括の中に並ぶ");
        waitUntil(() -> allEnded(batchId), "rerun ended");

        List<ComputeJobRecord> rows = ledger.jobsOfBatch(batchId);
        assertEquals(4, rows.size(), "古い行は残り、2 回目の行が 1 つ増える");
        ComputeJobRecord second = rows.stream().filter(j -> "b".equals(j.itemKey) && j.attempt == 2).findFirst().orElseThrow();
        assertEquals("DONE", second.state, second.errorValue);
        assertEquals("FAILED", rows.stream().filter(j -> "b".equals(j.itemKey) && j.attempt == 1).findFirst().orElseThrow().state,
                "1 回目の失敗の記録は残る");
        assertEquals(ledger.inputsOf(failed), ledger.inputsOf(second), "入力のシリーズは 1 回目と同じ");
        assertEquals(failed.pluginVersion, second.pluginVersion);
        assertTrue(ledger.latestAttempts(batchId).stream().allMatch(j -> j.state.equals("DONE")), "最新の試行はすべて完了");
        assertNotEquals(first.id(), second.requestId, "2 回目の行は新しい要求につながる");

        assertEquals("not-approved", ((Map<?, ?>) rerun.run(new ComputeBatchController.RunBody(
                (String) body(created, "requestId"), 120)).getBody()).get("error"), "🔴 再実行の承認も 1 回きり");
        assertEquals(2, count("\"egress-consumed\""), "承認は最初の一括と再実行で 1 回ずつ");
        assertEquals(1, count("\"compute-rerun-requested\""));
        assertEquals(4, count("\"compute-uploaded\""), "送ったのは 3 組 + 再実行の 1 組");
        assertTrue(jupyter.client.list("graphy").isEmpty(), "🔴 計算機にデータを残さない");
    }

    @Test
    void anInteractiveRunCanBeRerunAgainAndAgain() throws Exception {
        String handle = datasets.create(DatasetFixture.STUDY, DatasetFixture.CT_SERIES, ComputeDatasetService.Format.NPZ).handle();
        ComputeEgressService.EgressRequest r = egress.create("seg", "Seg", "local", List.of(handle),
                "raise ValueError('always')", CodeInspector.MAX_JOB_CHARS);
        egress.decide(r.id(), true, r.contentHash()).orElseThrow();
        runner.submit("seg", r.id(), 120);
        waitUntil(() -> ledger.list().stream().allMatch(j -> ComputeJobStateMachine.State.valueOf(j.state).ended())
                && !ledger.list().isEmpty(), "first ended");
        ComputeJobRecord j1 = ledger.list().get(0);
        assertEquals("FAILED", j1.state);
        String batchId = j1.batchId;

        approveAndRun(rerun.rerunJob(j1.id, null));
        waitUntil(() -> allEnded(batchId) && ledger.jobsOfBatch(batchId).size() == 2, "attempt 2 ended");
        ComputeJobRecord j2 = ledger.latestAttempts(batchId).get(0);
        assertEquals(2, j2.attempt);
        assertEquals("FAILED", j2.state);
        assertEquals(HttpStatus.CONFLICT, rerun.rerunJob(j1.id, null).getStatusCode(), "古い試行（1 回目）は再実行しない");

        approveAndRun(rerun.rerunJob(j2.id, null)); // 最新の試行はまた再実行できる
        waitUntil(() -> allEnded(batchId) && ledger.jobsOfBatch(batchId).size() == 3, "attempt 3 ended");
        assertEquals(3, ledger.latestAttempts(batchId).get(0).attempt);
        assertEquals(3, ledger.jobsOfBatch(batchId).size());
        assertEquals(1, ledger.batchRecord(batchId).stream().count(), "バッチは 1 つのまま");
        assertTrue(jupyter.client.list("graphy").isEmpty());
    }
}
