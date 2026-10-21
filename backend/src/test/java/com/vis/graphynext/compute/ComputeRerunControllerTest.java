/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.compute.ComputeJobStateMachine.Reason;
import com.vis.graphynext.compute.ComputeJobStateMachine.State;
import com.vis.graphynext.plugin.PluginArtifacts;
import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginManifest;
import com.vis.graphynext.plugin.PluginRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 再実行の口（記録から要求を作り直す・同意は毎回・版の違い・消えたシリーズ・動いている組があるバッチ）。実行は統合テスト。 */
class ComputeRerunControllerTest {

    @TempDir
    Path dir;

    private DatasetFixture fx;
    private ComputeEgressService egress;
    private ComputeJobLedger ledger;
    private ComputeEndpointRegistry endpoints;
    private ComputeRerunController ctl;
    private final AtomicReference<String> currentVersion = new AtomicReference<>("1.0.0");
    private final AtomicReference<List<PluginManifest>> manifests = new AtomicReference<>();

    @BeforeEach
    void setUp() throws Exception {
        fx = new DatasetFixture(dir);
        fx.writeCtSeries();
        ComputeDatasetService datasets = fx.service();
        datasets.useTempRoot(Files.createDirectories(dir.resolve("tmp")));
        endpoints = new ComputeEndpointRegistry();
        endpoints.replaceAll(List.of(
                new ComputeEndpointRegistry.Incoming("lab", "Lab", "https://gpu.example.org/", "T"),
                new ComputeEndpointRegistry.Incoming("lab2", "Lab 2", "https://gpu2.example.org/", "T")));
        ComputeAuditLog audit = new ComputeAuditLog(dir.resolve("audit.jsonl").toString(), fx.mapper);
        egress = new ComputeEgressService(endpoints, datasets, audit);
        manifests.set(List.of(new PluginManifest("seg", "Seg", "1.0.0", null, null, List.of("remote-compute"), null)));
        PluginRegistry plugins = (PluginRegistry) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{PluginRegistry.class}, (p, m, a) -> {
                    if (m.getName().equals("manifests")) {
                        return manifests.get();
                    }
                    throw new UnsupportedOperationException(m.getName());
                });
        PluginJobService jobs = new PluginJobService(plugins, new PluginArtifacts());
        ledger = new ComputeJobLedger(new InMemoryComputeJobStore(), fx.mapper, dir.resolve("compute-jobs"),
                java.time.Clock.systemUTC(), id -> new ComputeJobLedger.PluginFacts("Seg", currentVersion.get(), null));
        ComputeJobRunner runner = new ComputeJobRunner(egress, endpoints, datasets, audit, jobs, fx.mapper, ledger);
        ctl = new ComputeRerunController(plugins, endpoints, datasets, egress, runner, ledger);
    }

    private static final String CODE = "print('rerun me')";

    private ComputeEgressService.EgressRequest request(String endpointId) {
        return new ComputeEgressService.EgressRequest("egr_orig", "seg", "Seg", endpointId, "Lab",
                "https://gpu.example.org/", false, "jupyter", List.of(), CODE, ComputeEgressService.sha256(CODE), "anon",
                "hash", Instant.now(), ComputeEgressService.Status.CONSUMED);
    }

    private List<ComputeJobLedger.InputRef> series() {
        return List.of(new ComputeJobLedger.InputRef(DatasetFixture.STUDY, DatasetFixture.CT_SERIES, "npz"));
    }

    private String batch(boolean interactive, String endpointId) {
        String b = ledger.createBatch(request(endpointId), 600, interactive);
        return b;
    }

    private String job(String batchId, String key, State end, Reason reason, int attempt) {
        String id = ledger.createJob(batchId, request("lab"), key, series(), attempt);
        ledger.start(id, null);
        ledger.finish(id, end, reason, reason == Reason.CODE_ERROR ? "ValueError" : null, null, 0);
        return id;
    }

    @SuppressWarnings("unchecked")
    private static <T> T body(ResponseEntity<?> r, String key) {
        return (T) ((Map<String, Object>) r.getBody()).get(key);
    }

    // ── 1 件 ──

    @Test
    void aFailedRowIsRerunWithANewRequestThatNeedsANewApproval() {
        String b = batch(false, "lab");
        String failed = job(b, "k1", State.FAILED, Reason.CODE_ERROR, 1);

        ResponseEntity<Map<String, Object>> r = ctl.rerunJob(failed, null);
        assertEquals(HttpStatus.OK, r.getStatusCode(), String.valueOf(r.getBody()));
        String reqId = body(r, "requestId");
        assertNotEquals("egr_orig", reqId, "🔴 前の実行の承認は使わない（新しい要求）");
        ComputeEgressService.EgressRequest ticket = egress.detail(reqId).orElseThrow();
        assertEquals("Seg", ticket.pluginName());
        assertEquals(CODE, ticket.code(), "記録のコードで作る");
        assertEquals(List.of("k1"), ticket.items().stream().map(ComputeEgressService.Item::key).toList());
        assertEquals("2", ticket.rerun().get("attempt"));
        assertEquals(b, ticket.rerun().get("batchId"));
        assertTrue(egress.consumeRerun(reqId).isEmpty(), "🔴 承認するまで走らせられない");
        assertTrue(egress.consumeFor("seg", reqId).isEmpty(), "🔴 再実行の札はプラグインの口から使えない");
        egress.decide(reqId, true, ticket.contentHash()).orElseThrow();
        assertTrue(egress.consumeFor("seg", reqId).isEmpty(), "承認後でもプラグインの口からは使えない");
        assertTrue(egress.consumeRerun(reqId).isPresent());
        assertTrue(egress.consumeRerun(reqId).isEmpty(), "🔴 1 回きり");
    }

    @Test
    void anInteractiveRunKeepsTheOriginalHashFormat() {
        String b = batch(true, "lab");
        String failed = job(b, null, State.FAILED, Reason.TIMEOUT, 1);
        ResponseEntity<Map<String, Object>> r = ctl.rerunJob(failed, null);
        assertEquals(HttpStatus.OK, r.getStatusCode(), String.valueOf(r.getBody()));
        ComputeEgressService.EgressRequest t = egress.detail((String) body(r, "requestId")).orElseThrow();
        assertEquals(null, t.items(), "対話の 1 回は組なし（v1 の札）");
        assertEquals(1, t.datasets().size());
    }

    @Test
    void onlyFailedInterruptedOrCancelledLatestAttemptsCanBeRerun() {
        String b = batch(false, "lab");
        String done = job(b, "d", State.DONE, null, 1);
        String cancelled = job(b, "c", State.CANCELLED, null, 1);
        String interrupted = job(b, "i", State.INTERRUPTED, Reason.INTERRUPTED, 1);
        String oldFail = job(b, "o", State.FAILED, Reason.CODE_ERROR, 1);
        job(b, "o", State.DONE, null, 2); // o は 2 回目で直った

        assertEquals(HttpStatus.CONFLICT, ctl.rerunJob(done, null).getStatusCode(), "完了は対象外");
        assertEquals(HttpStatus.OK, ctl.rerunJob(cancelled, null).getStatusCode());
        assertEquals(HttpStatus.OK, ctl.rerunJob(interrupted, null).getStatusCode());
        ResponseEntity<Map<String, Object>> old = ctl.rerunJob(oldFail, null);
        assertEquals(HttpStatus.CONFLICT, old.getStatusCode(), "古い試行は再実行しない");
        assertEquals("not-rerunnable", body(old, "error"));
        assertEquals(HttpStatus.NOT_FOUND, ctl.rerunJob("cj_not-a-real-id", null).getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, ctl.rerunJob("cj_00000000-0000-0000-0000-000000000000", null).getStatusCode());
    }

    @Test
    void aBatchWithRunningItemsIsNotRerun() {
        String b = batch(false, "lab");
        String failed = job(b, "k1", State.FAILED, Reason.CODE_ERROR, 1);
        ledger.createJob(b, request("lab"), "k2", series()); // 待ちのまま
        ResponseEntity<Map<String, Object>> r = ctl.rerunJob(failed, null);
        assertEquals(HttpStatus.CONFLICT, r.getStatusCode());
        assertEquals("batch-active", body(r, "error"));
        assertEquals(HttpStatus.CONFLICT, ctl.rerunFailed(b, null).getStatusCode());
    }

    @Test
    void thePluginMustStillBeInstalledWithThePermission() {
        String b = batch(false, "lab");
        String failed = job(b, "k1", State.FAILED, Reason.CODE_ERROR, 1);
        manifests.set(List.of());
        assertEquals("plugin-unavailable", body(ctl.rerunJob(failed, null), "error"));
        manifests.set(List.of(new PluginManifest("seg", "Seg", "1.0.0", null, null, List.of(), null)));
        assertEquals("plugin-unavailable", body(ctl.rerunJob(failed, null), "error"), "権限が無ければ再実行できない");
    }

    // ── 版・計算機・消えたシリーズ ──

    @Test
    void aDifferentPluginVersionIsFlaggedOnTheRequestAndTheSameVersionIsNot() {
        String b = batch(false, "lab");
        String failed = job(b, "k1", State.FAILED, Reason.CODE_ERROR, 1);
        ResponseEntity<Map<String, Object>> same = ctl.rerunJob(failed, null);
        Map<String, String> rerunSame = body(same, "rerun");
        assertEquals("false", rerunSame.get("changed"));
        assertEquals("1.0.0", rerunSame.get("recordedVersion"));

        currentVersion.set("2.0.0"); // プラグインが更新された
        ResponseEntity<Map<String, Object>> changed = ctl.rerunJob(failed, null);
        Map<String, String> r2 = body(changed, "rerun");
        assertEquals("true", r2.get("changed"));
        assertEquals("1.0.0", r2.get("recordedVersion"));
        assertEquals("2.0.0", r2.get("currentVersion"));
        ComputeEgressService.EgressRequest t = egress.detail((String) body(changed, "requestId")).orElseThrow();
        assertEquals("true", t.rerun().get("changed"));
        assertEquals(CODE, t.code(), "版が違っても、走るのは記録のコード");
    }

    @Test
    void theRerunHashDoesNotIncludeTheNotice() {
        String b = batch(false, "lab");
        String failed = job(b, "k1", State.FAILED, Reason.CODE_ERROR, 1);
        ComputeEgressService.EgressRequest t = egress.detail((String) body(ctl.rerunJob(failed, null), "requestId")).orElseThrow();
        assertEquals(ComputeEgressService.contentHashBatch("seg", "lab", t.endpointUrl(), t.items(), t.codeSha256()),
                t.contentHash(), "注記は表示だけで、送る内容のハッシュには入らない");
    }

    @Test
    void aMissingComputerIsRefusedUntilAnotherIsChosen() {
        String b = batch(false, "gone");
        String failed = ledger.createJob(b, request("gone"), "k1", series(), 1); // 走らせた計算機が今は登録に無い
        ledger.start(failed, null);
        ledger.finish(failed, State.FAILED, Reason.ENDPOINT_UNREACHABLE, null, null, 0);
        ResponseEntity<Map<String, Object>> r = ctl.rerunJob(failed, null);
        assertEquals(HttpStatus.CONFLICT, r.getStatusCode());
        assertEquals("unknown-endpoint", body(r, "error"));
        ResponseEntity<Map<String, Object>> chosen = ctl.rerunJob(failed, new ComputeRerunController.RerunBody("lab2"));
        assertEquals(HttpStatus.OK, chosen.getStatusCode(), String.valueOf(chosen.getBody()));
        ComputeEgressService.EgressRequest t = egress.detail((String) body(chosen, "requestId")).orElseThrow();
        assertEquals("lab2", t.endpointId(), "選び直した計算機が同意画面の送り先になる");
        assertEquals("https://gpu2.example.org/", t.endpointUrl());
        assertEquals("unknown-endpoint", body(ctl.rerunJob(failed, new ComputeRerunController.RerunBody("nope")), "error"));
    }

    @Test
    void theRerunDefaultsToTheComputerTheLastAttemptRanOn() {
        String b = batch(false, "gone"); // バッチの記録の計算機はもう無い
        String id = ledger.createJob(b, request("lab2"), "k1", series(), 1); // 直前の試行は lab2 で走った
        ledger.start(id, null);
        ledger.finish(id, State.FAILED, Reason.CODE_ERROR, "E", null, 0);
        ResponseEntity<Map<String, Object>> r = ctl.rerunJob(id, null);
        assertEquals(HttpStatus.OK, r.getStatusCode(), String.valueOf(r.getBody()));
        assertEquals("lab2", egress.detail((String) body(r, "requestId")).orElseThrow().endpointId());
        assertEquals("lab2", ledger.view(ledger.find(id).orElseThrow()).get("endpointId"), "窓には試行ごとの計算機が出る");
    }

    @Test
    void aRowWhoseSeriesWasDeletedCannotBeRerun() {
        String b = batch(false, "lab");
        String id = ledger.createJob(b, request("lab"), "k1", List.of(new ComputeJobLedger.InputRef("", "", "npz")));
        ledger.start(id, null);
        ledger.finish(id, State.FAILED, Reason.CODE_ERROR, "E", null, 0);
        ResponseEntity<Map<String, Object>> r = ctl.rerunJob(id, null);
        assertEquals(HttpStatus.CONFLICT, r.getStatusCode());
        assertEquals("series-deleted", body(r, "error"));
        assertEquals(List.of(Map.of("key", "k1", "reason", "series-deleted")), body(r, "refused"));
    }

    @Test
    void codeThatTheInspectorRejectsNowIsRejectedOnRerunToo() {
        ComputeEgressService.EgressRequest big = new ComputeEgressService.EgressRequest("egr_big", "seg", "Seg", "lab", "Lab",
                "https://gpu.example.org/", false, "jupyter", List.of(), "x".repeat(CodeInspector.MAX_JOB_CHARS + 1), "sha", "anon",
                "hash", Instant.now(), ComputeEgressService.Status.CONSUMED);
        String b = ledger.createBatch(big, 600, false);
        String failed = job(b, "k1", State.FAILED, Reason.CODE_ERROR, 1);
        ResponseEntity<Map<String, Object>> r = ctl.rerunJob(failed, null);
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, r.getStatusCode());
        assertEquals("code-too-large", body(r, "error"));
    }

    // ── 失敗だけ ──

    @Test
    void failedOnlyTakesTheLatestFailedOrInterruptedItemsAndLeavesTheDoneOnes() {
        String b = batch(false, "lab");
        job(b, "ok1", State.DONE, null, 1);
        job(b, "bad1", State.FAILED, Reason.CODE_ERROR, 1);
        job(b, "bad2", State.INTERRUPTED, Reason.INTERRUPTED, 1);
        job(b, "fixed", State.FAILED, Reason.CODE_ERROR, 1);
        job(b, "fixed", State.DONE, null, 2);
        job(b, "cancelled", State.CANCELLED, null, 1);

        ResponseEntity<Map<String, Object>> r = ctl.rerunFailed(b, null);
        assertEquals(HttpStatus.OK, r.getStatusCode(), String.valueOf(r.getBody()));
        ComputeEgressService.EgressRequest t = egress.detail((String) body(r, "requestId")).orElseThrow();
        assertEquals(List.of("bad1", "bad2"), t.items().stream().map(ComputeEgressService.Item::key).sorted().toList(),
                "🔴 最新の試行が失敗・中断の組だけ（完了・直った組・中止は含まない）");
        assertEquals("2", t.rerun().get("attempt"));
    }

    @Test
    void failedOnlyWithNothingFailedIsRefused() {
        String b = batch(false, "lab");
        job(b, "ok1", State.DONE, null, 1);
        ResponseEntity<Map<String, Object>> r = ctl.rerunFailed(b, null);
        assertEquals(HttpStatus.CONFLICT, r.getStatusCode());
        assertEquals("no-failed-items", body(r, "error"));
        assertEquals(HttpStatus.NOT_FOUND, ctl.rerunFailed("not-a-batch", null).getStatusCode());
    }

    @Test
    void failedOnlyDropsDeletedSeriesWithTheirReasonAndRerunsTheRest() {
        String b = batch(false, "lab");
        String del = ledger.createJob(b, request("lab"), "gone", List.of(new ComputeJobLedger.InputRef("", "", "npz")));
        ledger.start(del, null);
        ledger.finish(del, State.FAILED, Reason.CODE_ERROR, "E", null, 0);
        job(b, "alive", State.FAILED, Reason.CODE_ERROR, 1);
        ResponseEntity<Map<String, Object>> r = ctl.rerunFailed(b, null);
        assertEquals(HttpStatus.OK, r.getStatusCode(), String.valueOf(r.getBody()));
        ComputeEgressService.EgressRequest t = egress.detail((String) body(r, "requestId")).orElseThrow();
        assertEquals(List.of("alive"), t.items().stream().map(ComputeEgressService.Item::key).toList());
        assertEquals(List.of(Map.of("key", "gone", "reason", "series-deleted")), t.refused(), "🔴 外した組は同意画面に理由つきで出る");
    }

    @Test
    void runningARerunNeedsAnApprovedRerunTicket() {
        assertEquals(HttpStatus.CONFLICT, ctl.run(new ComputeBatchController.RunBody("egr_nope", null)).getStatusCode());
        assertEquals(HttpStatus.CONFLICT, ctl.run(null).getStatusCode());
        // 未承認の再実行の札は走らない
        String b = batch(false, "lab");
        String failed = job(b, "k1", State.FAILED, Reason.CODE_ERROR, 1);
        String reqId = body(ctl.rerunJob(failed, null), "requestId");
        ResponseEntity<?> r = ctl.run(new ComputeBatchController.RunBody(reqId, null));
        assertEquals(HttpStatus.CONFLICT, r.getStatusCode());
        assertFalse(egress.approvedRerun(reqId).isPresent());
    }
}
