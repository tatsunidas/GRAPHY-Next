/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

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
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 一括の口（権限・組名・送れない組の扱い・空き容量・他のプラグインの行は見せない）。
 * 計算機には繋がない（実行は ComputeBatchIntegrationTest）。
 */
class ComputeBatchControllerTest {

    @TempDir
    Path dir;

    private DatasetFixture fx;
    private ComputeDatasetService datasets;
    private ComputeJobLedger ledger;
    private ComputeBatchController ctl;
    private InMemoryComputeJobStore store;

    @BeforeEach
    void setUp() throws Exception {
        fx = new DatasetFixture(dir);
        fx.writeCtSeries();
        datasets = fx.service();
        datasets.useTempRoot(Files.createDirectories(dir.resolve("tmp")));
        ComputeEndpointRegistry endpoints = new ComputeEndpointRegistry();
        endpoints.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("lab", "Lab", "https://gpu.example.org/", "T")));
        ComputeAuditLog audit = new ComputeAuditLog(dir.resolve("audit.jsonl").toString(), fx.mapper);
        ComputeEgressService egress = new ComputeEgressService(endpoints, datasets, audit);
        PluginRegistry plugins = (PluginRegistry) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{PluginRegistry.class}, (p, m, a) -> {
                    if (m.getName().equals("manifests")) {
                        return List.of(
                                new PluginManifest("seg", "Seg", "1.0.0", null, null, List.of("remote-compute"), null),
                                new PluginManifest("noperm", "NoPerm", "1.0.0", null, null, List.of(), null),
                                new PluginManifest("other", "Other", "1.0.0", null, null, List.of("remote-compute"), null));
                    }
                    throw new UnsupportedOperationException(m.getName());
                });
        PluginJobService jobs = new PluginJobService(plugins, new PluginArtifacts());
        store = new InMemoryComputeJobStore();
        ledger = new ComputeJobLedger(store, fx.mapper, dir.resolve("compute-jobs"), java.time.Clock.systemUTC(),
                id -> new ComputeJobLedger.PluginFacts("Seg", "1.0.0", null));
        ComputeJobRunner runner = new ComputeJobRunner(egress, endpoints, datasets, audit, jobs, fx.mapper, ledger);
        ctl = new ComputeBatchController(plugins, datasets, egress, runner, ledger);
    }

    private static ComputeEgressController.Input in(String series) {
        return new ComputeEgressController.Input(DatasetFixture.STUDY, series, "npz");
    }

    private static ComputeBatchController.BatchItem item(String key, String series) {
        return new ComputeBatchController.BatchItem(key, List.of(in(series)));
    }

    private static final String CODE = "print(1)";

    private ResponseEntity<Map<String, Object>> create(String plugin, ComputeBatchController.BatchItem... items) {
        return ctl.create(plugin, new ComputeBatchController.BatchBody("lab", CODE, List.of(items)));
    }

    @Test
    void aPluginWithoutThePermissionIsRefused() {
        assertEquals(HttpStatus.FORBIDDEN, create("noperm", item("a", DatasetFixture.CT_SERIES)).getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, create("nobody", item("a", DatasetFixture.CT_SERIES)).getStatusCode());
    }

    @Test
    void badItemsAreRefusedBeforeAnythingIsAnonymized() {
        assertEquals(HttpStatus.BAD_REQUEST, ctl.create("seg", new ComputeBatchController.BatchBody("lab", CODE, List.of()))
                .getStatusCode());
        assertEquals("bad-item-key", create("seg", item("山田", DatasetFixture.CT_SERIES)).getBody().get("error"));
        assertEquals("bad-item-key", create("seg", item("a", DatasetFixture.CT_SERIES), item("a", DatasetFixture.CT_SERIES))
                .getBody().get("error"), "組名の重複");
        List<ComputeEgressController.Input> nine = java.util.Collections.nCopies(9, in(DatasetFixture.CT_SERIES));
        assertEquals("bad-inputs", create("seg", new ComputeBatchController.BatchItem("a", nine)).getBody().get("error"));
    }

    @Test
    void aGoodBatchReturnsEveryItemAndOneFlatList() {
        ResponseEntity<Map<String, Object>> r = create("seg", item("a", DatasetFixture.CT_SERIES),
                item("b", DatasetFixture.CT_SERIES), item("c", DatasetFixture.CT_SERIES));
        assertEquals(HttpStatus.OK, r.getStatusCode(), String.valueOf(r.getBody()));
        assertEquals(3, ((List<?>) r.getBody().get("items")).size());
        assertEquals(3, ((List<?>) r.getBody().get("datasets")).size());
        assertTrue(((List<?>) r.getBody().get("refused")).isEmpty());
        assertTrue(String.valueOf(r.getBody().get("requestId")).startsWith("egr_"));
    }

    @Test
    void anItemThatCannotBeSentIsDroppedWithItsReasonAndTheRestRemain() {
        ResponseEntity<Map<String, Object>> r = create("seg", item("ok1", DatasetFixture.CT_SERIES),
                item("missing", "9.9.9.9"), item("ok2", DatasetFixture.CT_SERIES));
        assertEquals(HttpStatus.OK, r.getStatusCode(), String.valueOf(r.getBody()));
        List<?> items = (List<?>) r.getBody().get("items");
        assertEquals(2, items.size(), "送れない組は外す");
        List<?> refused = (List<?>) r.getBody().get("refused");
        assertEquals(1, refused.size(), "🔴 黙って減らさない: 理由つきで返す");
        assertEquals("missing", ((Map<?, ?>) refused.get(0)).get("key"));
        assertEquals("series-not-found", ((Map<?, ?>) refused.get(0)).get("reason"));
        assertEquals(2, ((List<?>) r.getBody().get("datasets")).size());
    }

    @Test
    void ifNothingCanBeSentTheBatchIsRefused() {
        ResponseEntity<Map<String, Object>> r = create("seg", item("x", "9.9.9.9"), item("y", "8.8.8.8"));
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, r.getStatusCode());
        assertEquals("no-sendable-items", r.getBody().get("error"));
        assertEquals(2, ((List<?>) r.getBody().get("refused")).size());
    }

    @Test
    void notEnoughFreeSpaceIsRefusedWithTheNumbersAndLeavesNoData() throws Exception {
        datasets.useSpaceProbe(() -> 10); // 10 バイトしか空いていない
        ResponseEntity<Map<String, Object>> r = create("seg", item("a", DatasetFixture.CT_SERIES),
                item("b", DatasetFixture.CT_SERIES), item("c", DatasetFixture.CT_SERIES));
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, r.getStatusCode());
        assertEquals("disk-insufficient", r.getBody().get("error"));
        long need = ((Number) r.getBody().get("neededBytes")).longValue();
        assertTrue(need > 10, "見積もり（作れた分の平均 × 残りの組）を数字で返す: " + need);
        assertEquals(10L, ((Number) r.getBody().get("freeBytes")).longValue());
        try (var s = Files.list(dir.resolve("tmp"))) {
            assertEquals(0, s.count(), "🔴 断ったら作ったデータは全部消す");
        }
    }

    @Test
    void sufficientSpaceIsNotRefused() {
        datasets.useSpaceProbe(() -> Long.MAX_VALUE);
        assertEquals(HttpStatus.OK, create("seg", item("a", DatasetFixture.CT_SERIES), item("b", DatasetFixture.CT_SERIES))
                .getStatusCode());
    }

    @Test
    void otherPluginsRowsAreNotVisibleOrTouchable() {
        // seg の行を台帳に 1 つ作る
        ComputeEgressService.EgressRequest r = new ComputeEgressService.EgressRequest("egr_x", "seg", "Seg", "lab", "Lab",
                "https://gpu.example.org/", false, "jupyter", List.of(), "print(1)", "sha", "anon", "hash",
                java.time.Instant.now(), ComputeEgressService.Status.CONSUMED);
        String batch = ledger.createBatch(r, 60, false);
        String job = ledger.createJob(batch, r, "k1", List.of());
        ledger.finish(job, ComputeJobStateMachine.State.CANCELLED, null, null, null, 0);

        ResponseEntity<?> mine = ctl.jobs("seg", null, false);
        assertEquals(1, ((List<?>) mine.getBody()).size());
        ResponseEntity<?> theirs = ctl.jobs("other", null, false);
        assertEquals(0, ((List<?>) theirs.getBody()).size(), "🔴 他のプラグインの行は返さない");
        assertEquals(HttpStatus.NOT_FOUND, ctl.collected("other", job).getStatusCode(), "他のプラグインの行は「無い」と同じ答え");
        assertEquals(HttpStatus.NOT_FOUND, ((ResponseEntity<?>) ctl.artifact("other", job)).getStatusCode());
        assertEquals(HttpStatus.FORBIDDEN, ctl.collected("noperm", job).getStatusCode());
        assertEquals(HttpStatus.OK, ctl.collected("seg", job).getStatusCode());
        assertEquals(1, ((List<?>) ctl.jobs("seg", null, false).getBody()).size());
        assertEquals(0, ((List<?>) ctl.jobs("seg", null, true).getBody()).size(),
                "未受け取りだけ: CANCELLED は結果が無いので数えない");
        assertEquals(HttpStatus.NOT_FOUND, ((ResponseEntity<?>) ctl.artifact("seg", job)).getStatusCode(), "結果ファイルが無ければ 404");
        assertEquals(HttpStatus.NOT_FOUND, ctl.collected("seg", "cj_not-a-real-id").getStatusCode());
        assertEquals(Optional.of("seg"), ledger.batchOf(store.findJob(job).orElseThrow()).map(b -> b.pluginId));
    }

    @Test
    void theLogsOfAJobAreOnlyForItsOwnerAndTheRefusedItemsRideOnTheTicket() throws Exception {
        ResponseEntity<Map<String, Object>> r = create("seg", item("ok1", DatasetFixture.CT_SERIES), item("missing", "9.9.9.9"));
        assertEquals(HttpStatus.OK, r.getStatusCode());
        // 送らなかった組は札に載る（同意画面に出す）が、内容のハッシュには含まれない
        ComputeEgressService.EgressRequest ticket = egressOf().detail((String) r.getBody().get("requestId")).orElseThrow();
        assertEquals(List.of(Map.of("key", "missing", "reason", "series-not-found")), ticket.refused());
        assertEquals(ComputeEgressService.contentHashBatch("seg", "lab", ticket.endpointUrl(), ticket.items(),
                ticket.codeSha256()), ticket.contentHash(), "🔴 送らなかった組はハッシュに入らない（送る内容だけが対象）");

        ComputeEgressService.EgressRequest er = new ComputeEgressService.EgressRequest("egr_y", "seg", "Seg", "lab", "Lab",
                "https://gpu.example.org/", false, "jupyter", List.of(), "print(1)", "sha", "anon", "hash",
                java.time.Instant.now(), ComputeEgressService.Status.CONSUMED);
        String job = ledger.createJob(ledger.createBatch(er, 60, false), er, "k1", List.of());
        ledger.writeLogs(job, "out text", "", "Traceback X");
        ResponseEntity<?> mine = ctl.log("seg", job, "stdout");
        assertEquals("out text", mine.getBody());
        assertEquals("Traceback X", ctl.log("seg", job, "traceback").getBody());
        assertEquals(HttpStatus.NOT_FOUND, ctl.log("other", job, "stdout").getStatusCode(), "🔴 他のプラグインのログは見せない");
        assertEquals(HttpStatus.FORBIDDEN, ctl.log("noperm", job, "stdout").getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, ctl.log("seg", job, "nope").getStatusCode(), "kind は stdout/stderr/traceback だけ");
    }

    private ComputeEgressService egressOf() throws Exception {
        var f = ComputeBatchController.class.getDeclaredField("egress");
        f.setAccessible(true);
        return (ComputeEgressService) f.get(ctl);
    }

    @Test
    void batchOperationsRejectUnknownIds() {
        assertEquals(HttpStatus.NOT_FOUND, ctl.cancel("not-a-batch").getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, ctl.resume("not-a-batch").getStatusCode());
        assertEquals(HttpStatus.CONFLICT, ctl.cancel("cb_00000000-0000-0000-0000-000000000000").getStatusCode());
        assertEquals(HttpStatus.CONFLICT, ctl.resume("cb_00000000-0000-0000-0000-000000000000").getStatusCode());
    }
}
