/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.compute.ComputeJobStateMachine.State;
import com.vis.graphynext.plugin.PluginManifest;
import com.vis.graphynext.plugin.PluginRegistry;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 再実行（1 件・失敗だけ）。設計: fw/remote-compute-design.md §28。
 *
 * <p>台帳の記録（コード全文・入力のシリーズ・計算機）から要求を作り直す。<b>匿名化を通し直し</b>、同意は毎回 main の窓で
 * 取り直す（前の実行の承認は使えない）。計算ジョブの窓（プラグインを名乗れない別窓）から呼ばれるので、要求は
 * <b>記録したプラグイン</b>の名で作り、そのプラグインが今も入っていて {@code remote-compute} を持つことを確かめる。
 * 走るのは同じバッチの中の次の試行（{@code attempt + 1}）。コードは記録のもので、{@link CodeInspector} を通し直す。
 *
 * <p>何も送らない口（作るだけ）と、承認済みの札で走らせる口（{@code /reruns/run}）に分かれる。
 * 動いている組があるバッチ・完了した行・古い試行は再実行しない。
 */
@RestController
@Profile("standalone")
public class ComputeRerunController {

    private static final Pattern JOB_ID = Pattern.compile("cj_[0-9a-f-]{36}");
    private static final Pattern BATCH_ID = Pattern.compile("cb_[0-9a-f-]{36}");

    private final PluginRegistry plugins;
    private final ComputeEndpointRegistry endpoints;
    private final ComputeEgressService egress;
    private final ComputeJobRunner runner;
    private final ComputeJobLedger ledger;
    private final ComputeBatchBuilder builder;

    public ComputeRerunController(PluginRegistry plugins, ComputeEndpointRegistry endpoints,
                                  ComputeDatasetService datasets, ComputeEgressService egress,
                                  ComputeJobRunner runner, ComputeJobLedger ledger) {
        this.plugins = plugins;
        this.endpoints = endpoints;
        this.egress = egress;
        this.runner = runner;
        this.ledger = ledger;
        this.builder = new ComputeBatchBuilder(datasets);
    }

    /** {@code endpointId} は計算機を選び直すとき（省略すると記録の計算機）。 */
    public record RerunBody(String endpointId) {
    }

    /** 終わった失敗・中断・中止の 1 行を再実行する要求を作る。 */
    @PostMapping("/api/compute/jobs/{id}/rerun")
    public ResponseEntity<Map<String, Object>> rerunJob(@PathVariable String id,
                                                        @RequestBody(required = false) RerunBody body) {
        if (!JOB_ID.matcher(id).matches()) {
            return ResponseEntity.notFound().build();
        }
        ComputeJobRecord j = ledger.find(id).orElse(null);
        ComputeBatchRecord b = j == null ? null : ledger.batchOf(j).orElse(null);
        if (j == null || b == null) {
            return ResponseEntity.notFound().build();
        }
        State st = State.valueOf(j.state);
        boolean latest = ledger.latestAttempts(b.id).stream().anyMatch(x -> x.id.equals(j.id));
        if (!(st == State.FAILED || st == State.INTERRUPTED || st == State.CANCELLED) || !latest) {
            return error(HttpStatus.CONFLICT, "not-rerunnable");
        }
        return start(b, List.of(j), body == null ? null : body.endpointId());
    }

    /** 一括のうち、最新の試行が失敗・中断の組だけを再実行する要求を作る。 */
    @PostMapping("/api/compute/batches/{id}/rerun-failed")
    public ResponseEntity<Map<String, Object>> rerunFailed(@PathVariable String id,
                                                           @RequestBody(required = false) RerunBody body) {
        if (!BATCH_ID.matcher(id).matches()) {
            return ResponseEntity.notFound().build();
        }
        ComputeBatchRecord b = ledger.batchRecord(id).orElse(null);
        if (b == null) {
            return ResponseEntity.notFound().build();
        }
        List<ComputeJobRecord> failed = ledger.latestAttempts(id).stream()
                .filter(j -> State.valueOf(j.state) == State.FAILED || State.valueOf(j.state) == State.INTERRUPTED)
                .toList();
        if (failed.isEmpty()) {
            return error(HttpStatus.CONFLICT, "no-failed-items");
        }
        return start(b, failed, body == null ? null : body.endpointId());
    }

    private ResponseEntity<Map<String, Object>> start(ComputeBatchRecord b, List<ComputeJobRecord> sources,
                                                      String endpointOverride) {
        PluginManifest m = plugins.manifests().stream().filter(x -> x.id().equals(b.pluginId)).findFirst().orElse(null);
        if (m == null || m.permissions() == null || !m.permissions().contains(ComputeEgressController.PERMISSION)) {
            return error(HttpStatus.CONFLICT, "plugin-unavailable");
        }
        if (ledger.hasActive(b.id)) {
            return error(HttpStatus.CONFLICT, "batch-active");
        }
        // 既定は直前の試行を走らせた計算機（選び直していればそちら）。無ければバッチの記録
        String lastEndpoint = sources.get(0).endpointId != null ? sources.get(0).endpointId : b.endpointId;
        String endpointId = endpointOverride != null && !endpointOverride.isBlank() ? endpointOverride : lastEndpoint;
        if (endpoints.get(endpointId).isEmpty()) {
            return error(HttpStatus.CONFLICT, "unknown-endpoint");
        }
        // コードは記録のものを今の規則で確かめ直す（規則が厳しくなっていれば再実行も弾く）
        String problem = egress.precheck(b.pluginId, endpointId, b.code, CodeInspector.MAX_JOB_CHARS);
        if (problem != null) {
            return error(HttpStatus.UNPROCESSABLE_ENTITY, problem);
        }

        // 消えたシリーズの組は外して理由を出す（UID が空＝保管庫から消えた）
        boolean interactive = b.interactive && sources.size() == 1 && sources.get(0).itemKey == null;
        List<ComputeBatchController.BatchItem> items = new ArrayList<>();
        List<Map<String, String>> refusedRows = new ArrayList<>();
        for (ComputeJobRecord j : sources) {
            List<ComputeJobLedger.InputRef> refs = ledger.inputsOf(j);
            String key = j.itemKey == null ? "item" : j.itemKey;
            if (refs.stream().anyMatch(r -> r.seriesUid() == null || r.seriesUid().isEmpty())) {
                refusedRows.add(Map.of("key", key, "reason", "series-deleted"));
                continue;
            }
            items.add(new ComputeBatchController.BatchItem(key, refs.stream()
                    .map(r -> new ComputeEgressController.Input(r.studyUid(), r.seriesUid(), r.format())).toList()));
        }
        if (items.isEmpty()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", false);
            out.put("error", "series-deleted");
            out.put("refused", refusedRows);
            return ResponseEntity.status(HttpStatus.CONFLICT).body(out);
        }
        ComputeBatchBuilder.Prepared prepared;
        try {
            prepared = builder.prepare(items, egress.isLocalEndpoint(endpointId));
        } catch (ComputeBatchBuilder.Failure f) {
            return ResponseEntity.status(f.status).body(f.body);
        }
        List<Map<String, String>> refused = new ArrayList<>(refusedRows);
        prepared.refused().forEach(x -> refused.add(Map.of("key", String.valueOf(x.get("key")),
                "reason", String.valueOf(x.get("reason")))));

        // 記録の版と今の版（違えば同意画面に出す。記録のコードで走る）
        ComputeJobLedger.PluginFacts now = ledger.currentFacts(b.pluginId);
        String recorded = sources.get(0).pluginVersion != null ? sources.get(0).pluginVersion : b.pluginVersion;
        boolean changed = (recorded != null && now.version() != null && !recorded.equals(now.version()))
                || (b.pluginPackageSha256 != null && now.packageSha256() != null
                && !b.pluginPackageSha256.equals(now.packageSha256()));
        int attempt = sources.stream().mapToInt(j -> ledger.nextAttempt(b.id, j.itemKey)).max().orElse(2);
        Map<String, String> rerun = new LinkedHashMap<>();
        rerun.put("batchId", b.id);
        rerun.put("attempt", String.valueOf(attempt));
        rerun.put("recordedVersion", recorded == null ? "" : recorded);
        rerun.put("currentVersion", now.version() == null ? "" : now.version());
        rerun.put("changed", String.valueOf(changed));
        try {
            ComputeEgressService.EgressRequest r = interactive
                    ? egress.create(b.pluginId, b.pluginName, endpointId, prepared.kept().values().iterator().next(),
                            b.code, CodeInspector.MAX_JOB_CHARS, rerun)
                    : egress.createBatch(b.pluginId, b.pluginName, endpointId, prepared.kept(), b.code,
                            CodeInspector.MAX_JOB_CHARS, refused, rerun);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("requestId", r.id());
            out.put("endpoint", Map.of("id", r.endpointId(), "label", r.endpointLabel()));
            out.put("items", r.itemsOrSingle());
            out.put("refused", refused);
            out.put("datasets", r.datasets());
            out.put("rerun", rerun);
            return ResponseEntity.ok(out);
        } catch (ComputeEgressService.EgressRefused e) {
            builder.discard(prepared.all());
            return error(HttpStatus.UNPROCESSABLE_ENTITY, e.reason());
        } catch (RuntimeException e) {
            builder.discard(prepared.all());
            throw e;
        }
    }

    /** 承認済みの再実行の札で走らせる。<b>札はここで 1 回だけ使用済みになる。</b> */
    @PostMapping("/api/compute/reruns/run")
    public ResponseEntity<?> run(@RequestBody ComputeBatchController.RunBody body) {
        try {
            return ResponseEntity.ok(runner.submitRerun(body == null ? null : body.requestId(),
                    body == null ? null : body.timeoutSec()));
        } catch (ComputeEgressService.EgressRefused e) {
            return error(HttpStatus.CONFLICT, e.reason());
        }
    }

    private static ResponseEntity<Map<String, Object>> error(HttpStatus s, String reason) {
        return ResponseEntity.status(s).body(Map.of("ok", false, "error", reason));
    }
}
