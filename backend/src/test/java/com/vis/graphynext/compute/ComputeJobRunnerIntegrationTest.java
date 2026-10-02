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
    private ComputeEgressService egress;
    private ComputeJobRunner runner;
    private PluginJobService jobs;
    private final PluginArtifacts artifacts = new PluginArtifacts();

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
        ComputeDatasetService datasets = fx.service();
        ComputeAuditLog audit = new ComputeAuditLog(dir.resolve("audit.jsonl").toString(), fx.mapper);
        egress = new ComputeEgressService(endpoints, datasets, audit);
        PluginRegistry noPlugins = (PluginRegistry) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{PluginRegistry.class}, (p, m, a) -> {
                    throw new UnsupportedOperationException(m.getName());
                });
        jobs = new PluginJobService(noPlugins, artifacts);
        runner = new ComputeJobRunner(egress, endpoints, datasets, audit, jobs, fx.mapper);
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
}
