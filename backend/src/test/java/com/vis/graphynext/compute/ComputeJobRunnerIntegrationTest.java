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

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * H59 の通し: 既存の匿名化 → 承認の札 → アップロード → 実行 → 結果の回収 → 計算機の後片付け。
 * 本物の jupyter_server を使う（{@code GRAPHY_JUPYTER_PYTHON} が無ければ skip）。
 */
class ComputeJobRunnerIntegrationTest {

    private static LocalJupyter jupyter;

    @TempDir
    Path dir;

    private DatasetFixture fx;
    private ComputeEndpointRegistry endpoints;
    private ComputeEgressService egress;
    private ComputeJobRunner runner;
    private PluginJobService jobs;
    private final PluginArtifacts artifacts = new PluginArtifacts();
    private InMemoryComputeJobStore store;
    private ComputeJobLedger ledger;
    private ComputeAuditLog audit;

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
        ComputeDatasetService datasets = fx.service();
        audit = new ComputeAuditLog(dir.resolve("audit.jsonl").toString(), fx.mapper);
        egress = new ComputeEgressService(endpoints, datasets, audit);
        PluginRegistry noPlugins = (PluginRegistry) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{PluginRegistry.class}, (p, m, a) -> {
                    throw new UnsupportedOperationException(m.getName());
                });
        jobs = new PluginJobService(noPlugins, artifacts);
        store = new InMemoryComputeJobStore();
        ledger = new ComputeJobLedger(store, fx.mapper, dir.resolve("compute-jobs"), java.time.Clock.systemUTC(),
                id -> new ComputeJobLedger.PluginFacts("Seg", "1.0.0", null));
        runner = new ComputeJobRunner(egress, endpoints, datasets, audit, jobs, fx.mapper, ledger);
    }

    /** 要求を作って承認する（main の同意画面の代わり）。 */
    private String approved(String code) {
        ComputeDatasetService ds = datasetsOf();
        String handle = ds.create(DatasetFixture.STUDY, DatasetFixture.CT_SERIES, ComputeDatasetService.Format.NPZ).handle();
        ComputeEgressService.EgressRequest r = egress.create("seg", "Seg", "local", List.of(handle), code,
                CodeInspector.MAX_JOB_CHARS);
        egress.decide(r.id(), true, r.contentHash()).orElseThrow();
        return r.id();
    }

    private ComputeDatasetService datasetsOf() {
        try {
            var f = ComputeEgressService.class.getDeclaredField("datasets");
            f.setAccessible(true);
            return (ComputeDatasetService) f.get(egress);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    private PluginJobService.Status waitEnd(String jobId) throws InterruptedException {
        for (int i = 0; i < 1200; i++) {
            PluginJobService.Status s = jobs.status(jobId).orElseThrow();
            if (s.ended()) {
                return s;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("job did not end");
    }

    private void assertRemoteClean() {
        assertTrue(jupyter.client.list("graphy").isEmpty(), "🔴 計算機に患者由来のデータを残さない");
        assertTrue(jupyter.client.list("").stream().noneMatch(n -> n.path("type").asText().equals("notebook")));
    }

    @Test
    void runsOnTheRemoteKernelAndReturnsOutputs() throws Exception {
        String code = """
                import numpy as np, json, os
                z = np.load('inputs/0.npz')
                v = z['volume']
                print('__progress__', 0.5, 'thresholding')
                mask = (v > -1024 + 150).astype(np.uint8)
                os.makedirs('outputs/sub', exist_ok=True)
                np.save('outputs/mask.npy', mask)
                json.dump({'shape': list(v.shape), 'voxels': int(mask.sum())}, open('outputs/sub/summary.json', 'w'))
                print('shape', v.shape)
                """;
        PluginJobService.Status st = runner.submit("seg", approved(code), 120);
        PluginJobService.Status end = waitEnd(st.jobId());
        assertEquals(PluginJobService.State.DONE, end.state(), String.valueOf(end.error()));
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) end.result();
        assertEquals("ok", result.get("status"));
        assertTrue(String.valueOf(result.get("stdout")).contains("shape (3, 3, 4)"), String.valueOf(result.get("stdout")));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> files = (List<Map<String, Object>>) result.get("files");
        assertEquals(List.of("mask.npy", "sub/summary.json"), files.stream().map(f -> f.get("name")).sorted().toList());
        // 成果物（H53）として預かられ、無圧縮の zip で 1 ファイルずつ取り出せる
        Path zip = artifacts.find(st.jobId()).orElseThrow();
        try (ZipInputStream in = new ZipInputStream(Files.newInputStream(zip))) {
            for (ZipEntry e; (e = in.getNextEntry()) != null; ) {
                assertEquals(ZipEntry.STORED, e.getMethod(), e.getName());
                if (e.getName().equals("sub/summary.json")) {
                    String json = new String(in.readAllBytes());
                    assertTrue(json.contains("\"shape\": [3, 3, 4]"), json);
                    assertTrue(json.contains("\"voxels\": "), json);
                }
            }
        }
        assertRemoteClean();
    }

    @Test
    void pythonErrorsAreReportedAndOutputsStillCollected() throws Exception {
        String code = "open('outputs/partial.txt','w').write('half')\nraise ValueError('bad threshold')";
        PluginJobService.Status end = waitEnd(runner.submit("seg", approved(code), 60).jobId());
        assertEquals(PluginJobService.State.DONE, end.state());
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) end.result();
        assertEquals("error", result.get("status"));
        assertEquals("ValueError", result.get("errorName"));
        assertEquals("bad threshold", result.get("errorValue"));
        assertEquals(1, ((List<?>) result.get("files")).size());
        assertRemoteClean();
    }

    @Test
    void cancellingStopsTheKernelAndCleansUp() throws Exception {
        String code = "import time\nfor i in range(600):\n    print('__progress__', i / 600, 'waiting')\n    time.sleep(0.1)";
        PluginJobService.Status st = runner.submit("seg", approved(code), 600);
        for (int i = 0; i < 100 && jobs.status(st.jobId()).orElseThrow().progress() < 0.21; i++) {
            Thread.sleep(100);
        }
        jobs.cancel(st.jobId());
        PluginJobService.Status end = waitEnd(st.jobId());
        assertEquals(PluginJobService.State.CANCELLED, end.state());
        assertRemoteClean();
    }

    @Test
    void anApprovalRunsOnlyOnce_andOnlyForItsPlugin() throws Exception {
        String id = approved("print(1)");
        assertEquals("not-approved", assertThrows(ComputeEgressService.EgressRefused.class,
                () -> runner.submit("other-plugin", id, 60)).reason(), "🔴 別のプラグインの承認は使えない");
        PluginJobService.Status st = runner.submit("seg", id, 60);
        assertEquals("not-approved", assertThrows(ComputeEgressService.EgressRefused.class,
                () -> runner.submit("seg", id, 60)).reason(), "🔴 同じ承認で 2 回は走らない");
        assertEquals(PluginJobService.State.DONE, waitEnd(st.jobId()).state());
        String audit = Files.readString(dir.resolve("audit.jsonl"));
        assertTrue(audit.contains("\"compute-uploaded\"") && audit.contains("\"compute-finished\""), audit);
        assertFalse(audit.contains(DatasetFixture.PHI_NAME));
    }

    @Test
    void refusesToSendWhenTheDestinationChangedAfterApproval() throws Exception {
        String id = approved("print(1)");
        // 承認のあとに登録簿が入れ替わった（自機では Jupyter の起動し直しでポートが変わる）
        assertTrue(endpoints.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("local", "Local",
                jupyter.url + "/moved/", jupyter.token))).isEmpty());
        PluginJobService.Status st = runner.submit("seg", id, 60);
        PluginJobService.Status end = waitEnd(st.jobId());
        assertEquals(PluginJobService.State.FAILED, end.state());
        assertTrue(String.valueOf(end.error()).contains("destination-changed"), String.valueOf(end.error()));
        String audit = Files.readString(dir.resolve("audit.jsonl"));
        assertTrue(audit.contains("\"egress-destination-changed\""), audit);
        assertFalse(audit.contains("\"compute-uploaded\""), "🔴 何も送っていない");
        assertRemoteClean();
    }

    @Test
    void localEndpointRunsOnlyWhenTheKernelPythonIsTheChosenOne() throws Exception {
        // カーネルが実際に使う Python を先に測る（利用者の kernelspec 次第で、サーバの Python とは限らない）
        PluginJobService.Status probe = waitEnd(runner.submit("seg",
                approved("import sys; print('PY=' + sys.executable)"), 60).jobId());
        assertEquals(PluginJobService.State.DONE, probe.state(), String.valueOf(probe.error()));
        @SuppressWarnings("unchecked")
        String out = String.valueOf(((Map<String, Object>) probe.result()).get("stdout"));
        String kernelPython = out.lines().filter(l -> l.startsWith("PY=")).findFirst().orElseThrow().substring(3).strip();

        // 正例: 選んだ Python とカーネルの Python が同じ
        endpoints.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("local", "this-pc", jupyter.url + "/",
                jupyter.token, "local", kernelPython)));
        PluginJobService.Status ok = waitEnd(runner.submit("seg", approved("print('hello')"), 60).jobId());
        assertEquals(PluginJobService.State.DONE, ok.state(), String.valueOf(ok.error()));
        // 負例: 別の Python を「選んだもの」にすると、コードを走らせずに止める
        endpoints.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("local", "this-pc", jupyter.url + "/",
                jupyter.token, "local", dir.resolve("other-python").toString())));
        PluginJobService.Status ng = waitEnd(runner.submit("seg", approved("print('hello')"), 60).jobId());
        assertEquals(PluginJobService.State.FAILED, ng.state());
        assertTrue(String.valueOf(ng.error()).contains("kernel-python-mismatch"), String.valueOf(ng.error()));
        assertRemoteClean();
    }

    // ── 台帳と待ち行列（GP-JOB-001 段 1） ──

    /** 計算機（本物の jupyter_server）に今立っているカーネルの数。 */
    private int kernelCount() throws Exception {
        var req = java.net.http.HttpRequest.newBuilder(java.net.URI.create(jupyter.url + "/api/kernels"))
                .header("Authorization", "token " + jupyter.token).build();
        // jupyter_server はカーネルの起動の最中に一覧を引くと 500 を返すことがある（last_activity が未設定）。少し待って引き直す
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

    private ComputeJobRecord rowOf(PluginJobService.Status st) {
        return store.listJobs().stream().filter(j -> st.jobId().equals(j.pluginJobId)).findFirst().orElseThrow();
    }

    private void waitUntil(java.util.function.BooleanSupplier cond, String what) throws InterruptedException {
        for (int i = 0; i < 300 && !cond.getAsBoolean(); i++) {
            Thread.sleep(100);
        }
        assertTrue(cond.getAsBoolean(), "待っても起きなかった: " + what);
    }

    @Test
    void aSuccessfulJobLeavesALedgerRowWithLogsAndItsOutputsInTheJobFolder() throws Exception {
        PluginJobService.Status st = runner.submit("seg", approved(
                "import json\nprint('hello')\nopen('outputs/a.txt','w').write('x')"), 120);
        assertEquals(PluginJobService.State.DONE, waitEnd(st.jobId()).state());
        ComputeJobRecord j = rowOf(st);
        assertEquals("DONE", j.state);
        assertEquals("ok", j.remoteCleanup, "計算機の作業フォルダを消した記録");
        assertNotNull(j.envJson, "計算機の環境（Python の版など）を記録する: " + j.envJson);
        assertTrue(j.envJson.contains("\"python\""), j.envJson);
        assertEquals(1, ledger.inputsOf(j).size());
        assertTrue(ledger.readLog(j.id, "stdout").orElseThrow().contains("hello"));
        // 結果の zip は台帳のジョブのフォルダにあり、H53 の取り方（artifacts.find）はそこを指す
        Path zip = artifacts.find(st.jobId()).orElseThrow();
        assertEquals(ledger.jobDir(j.id).resolve("outputs.zip").toRealPath(), zip.toRealPath());
        assertTrue(j.outputsBytes > 0);
        ComputeBatchRecord b = ledger.batchOf(j).orElseThrow();
        assertEquals("seg", b.pluginId);
        assertTrue(b.code.contains("hello"));
        // 🔴 台帳の全列に患者名・患者 ID が無い（先に、同じ検査が元データでは見つけることを確かめる）
        String source = Files.readString(dir.resolve("ct0.dcm"), java.nio.charset.StandardCharsets.ISO_8859_1);
        assertTrue(source.contains(DatasetFixture.PHI_NAME) && source.contains(DatasetFixture.PHI_ID),
                "（前提）元の DICOM には患者名・患者 ID がある＝同じ grep が見つけられる");
        String everything = ledger.view(j).toString() + b.code + b.pluginName + String.join("",
                Files.walk(ledger.jobDir(j.id)).filter(Files::isRegularFile).map(f -> {
                    try {
                        return f.getFileName().toString().endsWith(".zip") ? "" : Files.readString(f);
                    } catch (java.io.IOException e) {
                        return "";
                    }
                }).toList());
        assertFalse(everything.contains(DatasetFixture.PHI_NAME) || everything.contains(DatasetFixture.PHI_ID),
                "🔴 台帳とログに患者名・患者 ID が入っていない");
    }

    @Test
    void aPythonErrorIsRecordedAsCodeErrorWithTheFullTraceback() throws Exception {
        PluginJobService.Status st = runner.submit("seg", approved("raise ValueError('bad threshold')"), 60);
        waitEnd(st.jobId());
        ComputeJobRecord j = rowOf(st);
        assertEquals("FAILED", j.state);
        assertEquals("code-error", j.reason);
        assertEquals("ValueError", j.errorName);
        assertEquals("bad threshold", j.errorValue);
        assertTrue(ledger.readLog(j.id, "traceback").orElseThrow().contains("ValueError"), "traceback の全文がファイルにある");
        assertRemoteClean();
    }

    @Test
    void anOutOfMemoryErrorIsShownAsACodeError() throws Exception {
        PluginJobService.Status st = runner.submit("seg", approved("raise MemoryError('CUDA out of memory')"), 60);
        waitEnd(st.jobId());
        ComputeJobRecord j = rowOf(st);
        assertEquals("code-error", j.reason);
        assertEquals("MemoryError", j.errorName);
    }

    @Test
    void aTimeoutIsRecordedAsTimeout() throws Exception {
        PluginJobService.Status st = runner.submit("seg", approved("import time\ntime.sleep(60)"), 10);
        PluginJobService.Status end = waitEnd(st.jobId());
        assertEquals(PluginJobService.State.FAILED, end.state());
        ComputeJobRecord j = rowOf(st);
        assertEquals("FAILED", j.state);
        assertEquals("timeout", j.reason);
        assertRemoteClean();
    }

    @Test
    void jobsOnTheSameEndpointRunOneAtATime_andAnotherEndpointDoesNotWait() throws Exception {
        endpoints.replaceAll(List.of(
                new ComputeEndpointRegistry.Incoming("local", "Local", jupyter.url, jupyter.token),
                new ComputeEndpointRegistry.Incoming("other", "Other", jupyter.url, jupyter.token)));
        PluginJobService.Status first = runner.submit("seg", approved("import time\ntime.sleep(4)\nprint('first')"), 120);
        waitUntil(() -> "RUNNING".equals(rowOf(first).state), "first running");
        PluginJobService.Status second = runner.submit("seg", approved("print('second')"), 120);
        assertEquals("QUEUED", rowOf(second).state, "2 本目は 1 本目が終わるまで待つ");
        assertEquals(PluginJobService.State.QUEUED, jobs.status(second.jobId()).orElseThrow().state());

        // 別の計算機へ投げたジョブは待たない（1 本目がまだ走っている間に終わる）
        String otherId = approvedOn("other", "print('third')");
        PluginJobService.Status third = runner.submit("seg", otherId, 120);
        int maxKernels = 0;
        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline && !(jobs.status(second.jobId()).orElseThrow().ended()
                && jobs.status(first.jobId()).orElseThrow().ended())) {
            maxKernels = Math.max(maxKernels, kernelCount());
            if (jobs.status(third.jobId()).orElseThrow().ended()
                    && !jobs.status(first.jobId()).orElseThrow().ended()) {
                assertEquals("QUEUED", rowOf(second).state, "別の計算機のジョブが先に終わった間も、同じ計算機の 2 本目は待つ");
            }
            Thread.sleep(100);
        }
        assertEquals(PluginJobService.State.DONE, waitEnd(first.jobId()).state());
        assertEquals(PluginJobService.State.DONE, waitEnd(second.jobId()).state());
        assertEquals(PluginJobService.State.DONE, waitEnd(third.jobId()).state());
        // 同じ計算機のカーネルは同時に 1 つ、別の計算機が加わっても 2 つまで
        assertTrue(maxKernels <= 2, "同時に立ったカーネル: " + maxKernels);
        assertTrue(!rowOf(second).startedAt.isBefore(rowOf(first).finishedAt),
                "🔴 2 本目は 1 本目が終わってから始まる");
    }

    @Test
    void cancellingAQueuedJobSendsNothing() throws Exception {
        PluginJobService.Status first = runner.submit("seg", approved("import time\ntime.sleep(4)"), 120);
        waitUntil(() -> "RUNNING".equals(rowOf(first).state), "first running");
        String id = approved("print('never')");
        PluginJobService.Status second = runner.submit("seg", id, 120);
        assertEquals("QUEUED", rowOf(second).state);
        assertTrue(runner.cancel(rowOf(second).id));
        assertEquals("CANCELLED", rowOf(second).state, "待ちのジョブは取り消しの要求のその場で中止になる");
        waitEnd(first.jobId());
        assertEquals(PluginJobService.State.CANCELLED, waitEnd(second.jobId()).state());
        String audit = Files.readString(dir.resolve("audit.jsonl"));
        assertEquals(1, audit.lines().filter(l -> l.contains("\"compute-uploaded\"")).count(),
                "🔴 中止した待ちのジョブは計算機へ 1 回もアップロードしていない（アップロードは 1 本目の 1 回だけ）");
        assertTrue(audit.contains("\"compute-job-cancelled\""));
        assertRemoteClean();
        assertEquals(0, kernelCount());
    }

    @Test
    void cancellingARunningJobFromTheLedgerStopsItAndCleansUp() throws Exception {
        String code = "import time\nfor i in range(600):\n    print('__progress__', i / 600, 'waiting')\n    time.sleep(0.1)";
        PluginJobService.Status st = runner.submit("seg", approved(code), 600);
        waitUntil(() -> "RUNNING".equals(rowOf(st).state) && rowOf(st).progress > 0.2, "running");
        assertTrue(runner.cancel(rowOf(st).id));
        assertEquals(PluginJobService.State.CANCELLED, waitEnd(st.jobId()).state());
        ComputeJobRecord j = rowOf(st);
        assertEquals("CANCELLED", j.state);
        assertEquals("ok", j.remoteCleanup);
        assertFalse(runner.cancel(j.id), "終わった行は取り消せない");
        assertRemoteClean();
        assertEquals(0, kernelCount(), "🔴 取り消したジョブのカーネルが計算機に残っていない");
    }

    /** 接続先を指定して承認する。 */
    private String approvedOn(String endpointId, String code) {
        ComputeDatasetService ds = datasetsOf();
        String handle = ds.create(DatasetFixture.STUDY, DatasetFixture.CT_SERIES, ComputeDatasetService.Format.NPZ).handle();
        ComputeEgressService.EgressRequest r = egress.create("seg", "Seg", endpointId, List.of(handle), code,
                CodeInspector.MAX_JOB_CHARS);
        egress.decide(r.id(), true, r.contentHash()).orElseThrow();
        return r.id();
    }

    @Test
    void samePythonComparesRealPaths() throws Exception {
        Path real = Files.createFile(dir.resolve("python-real"));
        Path link = Files.createSymbolicLink(dir.resolve("python-link"), real);
        assertTrue(ComputeJobRunner.samePython(real.toString(), link.toString()), "正例: 同じ実体");
        assertFalse(ComputeJobRunner.samePython(real.toString(), dir.resolve("nope").toString()), "負例: 別のパス");
        assertFalse(ComputeJobRunner.samePython(real.toString(), ""), "負例: 空");
        assertFalse(ComputeJobRunner.samePython(null, real.toString()));
    }
}
