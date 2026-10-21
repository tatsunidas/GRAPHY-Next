/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.plugin.PluginArtifacts;
import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginRegistry;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Proxy;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 一括（同じコードを組ごとの入力で走らせる。同意は 1 回）の通し。本物の jupyter_server を使う
 * （{@code GRAPHY_JUPYTER_PYTHON} が無ければ skip）。
 */
class ComputeBatchIntegrationTest {

    private static LocalJupyter jupyter;

    @TempDir
    Path dir;

    private DatasetFixture fx;
    private ComputeDatasetService datasets;
    private ComputeEndpointRegistry endpoints;
    private ComputeEgressService egress;
    private ComputeJobRunner runner;
    private PluginJobService jobs;
    private InMemoryComputeJobStore store;
    private ComputeJobLedger ledger;

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
        endpoints = new ComputeEndpointRegistry();
        endpoints.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("local", "Local", jupyter.url, jupyter.token)));
        datasets = fx.service();
        ComputeAuditLog audit = new ComputeAuditLog(dir.resolve("audit.jsonl").toString(), fx.mapper);
        egress = new ComputeEgressService(endpoints, datasets, audit);
        PluginRegistry noPlugins = (PluginRegistry) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{PluginRegistry.class}, (p, m, a) -> {
                    throw new UnsupportedOperationException(m.getName());
                });
        jobs = new PluginJobService(noPlugins, new PluginArtifacts());
        store = new InMemoryComputeJobStore();
        ledger = new ComputeJobLedger(store, fx.mapper, dir.resolve("compute-jobs"), java.time.Clock.systemUTC(),
                id -> new ComputeJobLedger.PluginFacts("Seg", "1.0.0", null));
        runner = new ComputeJobRunner(egress, endpoints, datasets, audit, jobs, fx.mapper, ledger);
    }

    // ── 部品 ──

    private String newDataset() {
        return datasets.create(DatasetFixture.STUDY, DatasetFixture.CT_SERIES, ComputeDatasetService.Format.NPZ).handle();
    }

    /** 組名を並べて 1 つの要求を作り、承認する（main の同意画面の代わり）。 */
    private ComputeEgressService.EgressRequest approvedBatch(String endpointId, String code, String... keys) {
        LinkedHashMap<String, List<String>> items = new LinkedHashMap<>();
        for (String k : keys) {
            items.put(k, List.of(newDataset()));
        }
        ComputeEgressService.EgressRequest r = egress.createBatch("seg", "Seg", endpointId, items, code,
                CodeInspector.MAX_JOB_CHARS);
        egress.decide(r.id(), true, r.contentHash()).orElseThrow();
        return r;
    }

    private ComputeJobRecord row(String jobId) {
        return ledger.find(jobId).orElseThrow();
    }

    private ComputeJobRecord rowOf(Map<String, Object> submitted, String key) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) submitted.get("items");
        return row((String) items.stream().filter(i -> i.get("key").equals(key)).findFirst().orElseThrow().get("jobId"));
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

    private int kernelCount() throws Exception {
        var req = java.net.http.HttpRequest.newBuilder(java.net.URI.create(jupyter.url + "/api/kernels"))
                .header("Authorization", "token " + jupyter.token).build();
        // jupyter_server はカーネルの起動の最中に一覧を引くと 500 を返すことがある。少し待って引き直す
        java.net.http.HttpResponse<String> res = null;
        for (int i = 0; i < 20; i++) {
            res = java.net.http.HttpClient.newHttpClient().send(req, java.net.http.HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() == 200) {
                return fx.mapper.readTree(res.body()).size();
            }
            Thread.sleep(100);
        }
        throw new AssertionError("kernel list: " + res.statusCode() + " " + res.body());
    }

    private void assertRemoteClean() {
        assertTrue(jupyter.client.list("graphy").isEmpty(), "🔴 計算機に患者由来のデータを残さない");
    }

    private long count(String needle) throws IOException {
        return Files.readString(dir.resolve("audit.jsonl")).lines().filter(l -> l.contains(needle)).count();
    }

    // ── テスト ──

    @Test
    void fiveItemsRunUnderOneApprovalOneAtATime() throws Exception {
        String code = "import numpy as np\nz = np.load('inputs/0.npz')\nprint('shape', z['volume'].shape)\n";
        ComputeEgressService.EgressRequest r = approvedBatch("local", code, "p1", "p2", "p3", "p4", "p5");
        Map<String, Object> submitted = runner.submitBatch("seg", r.id(), 120);
        String batchId = (String) submitted.get("batchId");
        int maxKernels = 0;
        long deadline = System.currentTimeMillis() + 120_000;
        while (!allEnded(batchId) && System.currentTimeMillis() < deadline) {
            maxKernels = Math.max(maxKernels, kernelCount());
            Thread.sleep(100);
        }
        assertTrue(allEnded(batchId));
        for (String k : List.of("p1", "p2", "p3", "p4", "p5")) {
            ComputeJobRecord j = rowOf(submitted, k);
            assertEquals("DONE", j.state, k + ": " + j.errorValue);
            assertEquals(k, j.itemKey);
            assertEquals("ok", j.remoteCleanup);
        }
        assertFalse(store.findBatch(batchId).orElseThrow().interactive, "一括は対話ではない");
        assertTrue(maxKernels <= 1, "🔴 計算機のカーネルが同時に 2 つ立たない: " + maxKernels);
        assertEquals(1, count("\"egress-consumed\""), "🔴 承認の札は 1 回だけ使われる（組ごとに使わない）");
        assertEquals(5, count("\"compute-uploaded\""), "5 組とも 1 回ずつアップロード");
        assertEquals("not-approved", assertThrows(ComputeEgressService.EgressRefused.class,
                () -> runner.submitBatch("seg", r.id(), 120)).reason(), "🔴 同じ承認で一括は 2 回走らない");
        // 組が終われば、そのデータは捨てられている
        r.datasets().forEach(d -> assertTrue(datasets.get(d.handle()).isEmpty()));
        assertRemoteClean();
        // 起動順は並べた順
        List<ComputeJobRecord> byStart = new ArrayList<>(ledger.jobsOfBatch(batchId));
        byStart.sort(java.util.Comparator.comparing(j -> j.startedAt));
        assertEquals(List.of("p1", "p2", "p3", "p4", "p5"), byStart.stream().map(j -> j.itemKey).toList());
    }

    @Test
    void oneItemChangedAfterApprovalFailsAloneAndTheRestRun() throws Exception {
        ComputeEgressService.EgressRequest r = approvedBatch("local", "print('ok')", "a", "b", "c");
        // 承認のあとで、b のデータを差し替える（承認した中身と違うものは送らない）
        String bHandle = r.items().get(1).datasets().get(0).handle();
        Files.writeString(datasets.get(bHandle).orElseThrow().file(), "tampered");
        Map<String, Object> submitted = runner.submitBatch("seg", r.id(), 120);
        String batchId = (String) submitted.get("batchId");
        waitUntil(() -> allEnded(batchId), "batch ended");
        assertEquals("DONE", rowOf(submitted, "a").state);
        ComputeJobRecord b = rowOf(submitted, "b");
        assertEquals("FAILED", b.state);
        assertEquals("dataset-changed", b.reason, "🔴 差し替えた組は『承認した中身と違う』で失敗する");
        assertEquals("DONE", rowOf(submitted, "c").state, "他の組は続けて走る");
        assertEquals(2, count("\"compute-uploaded\""), "差し替えた組は 1 バイトも送られていない");
        assertRemoteClean();
    }

    @Test
    void aCodeErrorInOneItemDoesNotStopTheOthers() throws Exception {
        Path counter = dir.resolve("counter.txt");
        String code = "import os\np = r'" + counter.toString().replace("\\", "/") + "'\n"
                + "n = int(open(p).read()) if os.path.exists(p) else 0\nopen(p, 'w').write(str(n + 1))\n"
                + "if n == 2:\n    raise ValueError('third fails')\n";
        ComputeEgressService.EgressRequest r = approvedBatch("local", code, "i0", "i1", "i2", "i3", "i4");
        Map<String, Object> submitted = runner.submitBatch("seg", r.id(), 120);
        String batchId = (String) submitted.get("batchId");
        waitUntil(() -> allEnded(batchId), "batch ended");
        List<ComputeJobRecord> rows = ledger.jobsOfBatch(batchId);
        assertEquals(4, rows.stream().filter(j -> j.state.equals("DONE")).count(), "完了 4");
        ComputeJobRecord failed = rows.stream().filter(j -> j.state.equals("FAILED")).findFirst().orElseThrow();
        assertEquals("code-error", failed.reason);
        assertEquals("ValueError", failed.errorName);
        assertEquals(1, rows.stream().filter(j -> j.state.equals("FAILED")).count(), "失敗 1");
        assertRemoteClean();
    }

    @Test
    void anUnreachableComputerPausesTheBatchInsteadOfFailingTheRest() throws Exception {
        try (FlakyProxy proxy = new FlakyProxy(jupyter)) {
            proxy.up();
            endpoints.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("flaky", "Flaky",
                    "http://127.0.0.1:" + proxy.port + "/", jupyter.token)));
            ComputeEgressService.EgressRequest r = approvedBatch("flaky", "print('hello')", "a", "b", "c");
            proxy.down();
            Map<String, Object> submitted = runner.submitBatch("seg", r.id(), 120);
            String batchId = (String) submitted.get("batchId");
            waitUntil(() -> "FAILED".equals(rowOf(submitted, "a").state), "first item fails");
            ComputeJobRecord a = rowOf(submitted, "a");
            assertEquals("endpoint-unreachable", a.reason);
            waitUntil(() -> ledger.isPaused(batchId), "batch paused");
            Thread.sleep(1500); // 残りが走り出さないこと
            assertEquals("QUEUED", rowOf(submitted, "b").state, "🔴 残りは失敗にせず待ちのまま");
            assertEquals("QUEUED", rowOf(submitted, "c").state);
            assertTrue(datasets.get(r.items().get(1).datasets().get(0).handle()).isPresent(), "🔴 入力のデータは捨てない");
            assertTrue(datasets.get(r.items().get(2).datasets().get(0).handle()).isPresent());
            assertEquals(0, count("\"compute-uploaded\""));
            assertEquals("endpoint-unreachable", store.findBatch(batchId).orElseThrow().pausedReason);
            assertEquals(-1, runner.resumeBatch("cb_00000000-0000-0000-0000-000000000000"));

            proxy.up(); // 計算機が戻った
            assertEquals(2, runner.resumeBatch(batchId), "待ちの 2 組を並べ直す");
            waitUntil(() -> allEnded(batchId), "batch ended after resume");
            assertEquals("FAILED", rowOf(submitted, "a").state, "失敗した組は再開でもやり直さない（再実行は別の操作）");
            assertEquals("DONE", rowOf(submitted, "b").state);
            assertEquals("DONE", rowOf(submitted, "c").state);
            assertFalse(ledger.isPaused(batchId));
            assertTrue(Files.readString(dir.resolve("audit.jsonl")).contains("compute-batch-paused"));
        }
    }

    @Test
    void anInteractiveJobGoesBeforeTheRemainingBatchItems() throws Exception {
        ComputeEgressService.EgressRequest r = approvedBatch("local", "import time\ntime.sleep(2)\nprint('x')",
                "s1", "s2", "s3");
        Map<String, Object> submitted = runner.submitBatch("seg", r.id(), 120);
        String batchId = (String) submitted.get("batchId");
        waitUntil(() -> "RUNNING".equals(rowOf(submitted, "s1").state), "s1 running");
        String handle = newDataset();
        ComputeEgressService.EgressRequest one = egress.create("seg", "Seg", "local", List.of(handle), "print('interactive')",
                CodeInspector.MAX_JOB_CHARS);
        egress.decide(one.id(), true, one.contentHash()).orElseThrow();
        PluginJobService.Status st = runner.submit("seg", one.id(), 120);
        waitUntil(() -> allEnded(batchId) && jobs.status(st.jobId()).orElseThrow().ended(), "all ended");
        ComputeJobRecord interactive = store.listJobs().stream().filter(j -> "interactive".equals(null) || j.itemKey == null)
                .findFirst().orElseThrow();
        ComputeJobRecord s1 = rowOf(submitted, "s1");
        ComputeJobRecord s2 = rowOf(submitted, "s2");
        assertTrue(!interactive.startedAt.isBefore(s1.finishedAt), "実行中の組は止めない（s1 が終わってから）");
        assertTrue(interactive.startedAt.isBefore(s2.startedAt), "🔴 対話の 1 回は、待っている一括の次の組より先に走る");
    }

    @Test
    void cancellingABatchStopsTheRunningItemAndSendsNothingForTheWaitingOnes() throws Exception {
        ComputeEgressService.EgressRequest r = approvedBatch("local",
                "import time\nfor i in range(600):\n    print('__progress__', i / 600, 'w')\n    time.sleep(0.1)", "k1", "k2", "k3");
        Map<String, Object> submitted = runner.submitBatch("seg", r.id(), 600);
        String batchId = (String) submitted.get("batchId");
        waitUntil(() -> "RUNNING".equals(rowOf(submitted, "k1").state) && rowOf(submitted, "k1").progress > 0.2, "k1 running");
        assertEquals(3, runner.cancelBatch(batchId));
        waitUntil(() -> allEnded(batchId), "all ended");
        for (String k : List.of("k1", "k2", "k3")) {
            assertEquals("CANCELLED", rowOf(submitted, k).state, k);
        }
        assertEquals(1, count("\"compute-uploaded\""), "🔴 待ちの組は計算機へ 1 回もアップロードしていない");
        r.datasets().forEach(d -> assertTrue(datasets.get(d.handle()).isEmpty(), "中止した組のデータは捨てる"));
        assertRemoteClean();
        assertEquals(0, kernelCount());
        assertEquals(-1, runner.cancelBatch(batchId), "終わった一括はメモリから手放している");
    }

    @Test
    void collectedAndOwnerFiltersWork() throws Exception {
        ComputeEgressService.EgressRequest r = approvedBatch("local",
                "open('outputs/r.txt', 'w').write('hi')", "m1");
        Map<String, Object> submitted = runner.submitBatch("seg", r.id(), 120);
        String batchId = (String) submitted.get("batchId");
        waitUntil(() -> allEnded(batchId), "ended");
        ComputeJobRecord j = rowOf(submitted, "m1");
        assertEquals("DONE", j.state);
        assertNotNull(ledger.jobDir(j.id).resolve("outputs.zip"));
        assertTrue(Files.isRegularFile(ledger.jobDir(j.id).resolve("outputs.zip")), "結果はジョブのフォルダにある（H53 の保管に頼らない）");
        assertEquals(null, row(j.id).collectedAt);
        assertTrue(ledger.markCollected(j.id));
        assertNotNull(row(j.id).collectedAt);
        assertEquals("seg", ledger.batchOf(j).orElseThrow().pluginId);
    }

    /** 計算機の前に置く TCP 中継。down() で閉じ、up() で同じポートに開き直す（「計算機に届かなくなる」を作る）。 */
    private static final class FlakyProxy implements AutoCloseable {
        final int port;
        private final LocalJupyter target;
        private volatile ServerSocket server;
        private final List<Socket> open = new CopyOnWriteArrayList<>();

        FlakyProxy(LocalJupyter target) throws IOException {
            this.target = target;
            try (ServerSocket s = new ServerSocket(0, 50, InetAddress.getLoopbackAddress())) {
                this.port = s.getLocalPort();
            }
        }

        void up() throws IOException {
            ServerSocket s = new ServerSocket();
            s.setReuseAddress(true);
            s.bind(new java.net.InetSocketAddress(InetAddress.getLoopbackAddress(), port), 50);
            server = s;
            Thread t = new Thread(() -> {
                while (!s.isClosed()) {
                    try {
                        Socket c = s.accept();
                        Socket u = new Socket(InetAddress.getLoopbackAddress(), Integer.parseInt(target.url.substring(target.url.lastIndexOf(':') + 1)));
                        open.add(c);
                        open.add(u);
                        pipe(c, u);
                        pipe(u, c);
                    } catch (IOException e) {
                        return;
                    }
                }
            }, "flaky-proxy");
            t.setDaemon(true);
            t.start();
        }

        void down() throws IOException {
            if (server != null) {
                server.close();
            }
            for (Socket s : open) {
                try {
                    s.close();
                } catch (IOException ignored) {
                    // 閉じるだけ
                }
            }
            open.clear();
        }

        private static void pipe(Socket from, Socket to) {
            Thread t = new Thread(() -> {
                try (InputStream in = from.getInputStream(); OutputStream out = to.getOutputStream()) {
                    byte[] buf = new byte[16384];
                    for (int n; (n = in.read(buf)) >= 0; ) {
                        out.write(buf, 0, n);
                        out.flush();
                    }
                } catch (IOException ignored) {
                    // 相手が閉じた
                } finally {
                    try {
                        to.close();
                    } catch (IOException ignored) {
                        // 閉じるだけ
                    }
                }
            }, "flaky-pipe");
            t.setDaemon(true);
            t.start();
        }

        @Override
        public void close() throws IOException {
            down();
        }
    }
}
