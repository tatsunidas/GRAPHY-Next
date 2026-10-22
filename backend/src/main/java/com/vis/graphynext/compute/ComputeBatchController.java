/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.plugin.PluginManifest;
import com.vis.graphynext.plugin.PluginRegistry;
import org.springframework.context.annotation.Profile;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 一括（同じコードを入力の組ごとに走らせる。同意は 1 回）の口。設計: fw/remote-compute-design.md §26。
 *
 * <p>ここでも<b>何も送らない</b>——全組を（既存の匿名化で）データセットにして、内容を確定した 1 つの要求を返すだけ。
 * 送ってよいかは main が自分のウィンドウで 1 回聞く。permission は {@link ComputeEgressController} と同じく backend で確かめる。
 * 組のうち送れないもの（焼き込み・格子など）は<b>その組だけ外し</b>、理由つきで返す（黙って減らさない）。
 */
@RestController
@Profile("standalone")
public class ComputeBatchController {

    private static final Pattern JOB_ID = Pattern.compile("cj_[0-9a-f-]{36}");
    private static final Pattern BATCH_ID = Pattern.compile("cb_[0-9a-f-]{36}");

    private final PluginRegistry plugins;
    private final ComputeDatasetService datasets;
    private final ComputeEgressService egress;
    private final ComputeJobRunner runner;
    private final ComputeJobLedger ledger;
    private final ComputeBatchBuilder builder;

    public ComputeBatchController(PluginRegistry plugins, ComputeDatasetService datasets,
                                  ComputeEgressService egress, ComputeJobRunner runner, ComputeJobLedger ledger) {
        this.plugins = plugins;
        this.datasets = datasets;
        this.egress = egress;
        this.runner = runner;
        this.ledger = ledger;
        this.builder = new ComputeBatchBuilder(datasets);
    }

    /** 1 組。{@code key} は組の名前（英数字・{@code . _ -} の 64 字まで。<b>患者名を入れないこと</b>）。 */
    public record BatchItem(String key, List<ComputeEgressController.Input> inputs) {
    }

    public record BatchBody(String endpointId, String code, List<BatchItem> items) {
    }

    @PostMapping("/api/plugins/{id}/compute/batches")
    public ResponseEntity<Map<String, Object>> create(@PathVariable String id, @RequestBody BatchBody body) {
        PluginManifest m = manifest(id);
        if (m == null) {
            return error(HttpStatus.NOT_FOUND, "unknown-plugin");
        }
        String endpointId = body == null ? null : body.endpointId();
        if (!permitted(m)) {
            egress.refused(id, endpointId, "permission-denied");
            return error(HttpStatus.FORBIDDEN, "permission-denied");
        }
        if (body == null || body.items() == null || body.items().isEmpty()) {
            return error(HttpStatus.BAD_REQUEST, "bad-items");
        }
        Set<String> seen = new HashSet<>();
        for (BatchItem it : body.items()) {
            if (it == null || it.key() == null || !ComputeEgressService.ITEM_KEY.matcher(it.key()).matches()
                    || !seen.add(it.key())) {
                return error(HttpStatus.BAD_REQUEST, "bad-item-key");
            }
            if (it.inputs() == null || it.inputs().size() > 8) {
                return error(HttpStatus.BAD_REQUEST, "bad-inputs");
            }
        }
        String problem = egress.precheck(id, endpointId, body.code(), CodeInspector.MAX_JOB_CHARS);
        if (problem != null) {
            return error(HttpStatus.UNPROCESSABLE_ENTITY, problem);
        }

        ComputeBatchBuilder.Prepared prepared;
        try {
            prepared = builder.prepare(body.items(), egress.isLocalEndpoint(endpointId));
        } catch (ComputeBatchBuilder.Failure f) {
            return ResponseEntity.status(f.status).body(f.body);
        }
        try {
            List<Map<String, String>> refusedRows = prepared.refused().stream()
                    .map(x -> Map.of("key", String.valueOf(x.get("key")), "reason", String.valueOf(x.get("reason"))))
                    .toList();
            ComputeEgressService.EgressRequest r = egress.createBatch(m.id(), m.name(), endpointId, prepared.kept(),
                    body.code(), CodeInspector.MAX_JOB_CHARS, refusedRows);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("requestId", r.id());
            out.put("endpoint", Map.of("id", r.endpointId(), "label", r.endpointLabel()));
            out.put("items", r.items());
            out.put("refused", prepared.refused());
            out.put("datasets", r.datasets());
            out.put("codeSha256", r.codeSha256());
            return ResponseEntity.ok(out);
        } catch (ComputeEgressService.EgressRefused e) {
            builder.discard(prepared.all());
            return error(HttpStatus.UNPROCESSABLE_ENTITY, e.reason());
        } catch (RuntimeException e) {
            builder.discard(prepared.all());
            throw e;
        }
    }

    public record RunBody(String requestId, Integer timeoutSec) {
    }

    /** 承認済みの一括を投入する。<b>札はここで 1 回だけ使用済みになる。</b>進み具合・結果は台帳（{@code jobs}）で読む。 */
    @PostMapping("/api/plugins/{id}/compute/batches/run")
    public ResponseEntity<?> run(@PathVariable String id, @RequestBody RunBody body) {
        PluginManifest m = manifest(id);
        if (m == null) {
            return error(HttpStatus.NOT_FOUND, "unknown-plugin");
        }
        if (!permitted(m)) {
            egress.refused(id, null, "permission-denied");
            return error(HttpStatus.FORBIDDEN, "permission-denied");
        }
        try {
            return ResponseEntity.ok(runner.submitBatch(id, body == null ? null : body.requestId(),
                    body == null ? null : body.timeoutSec()));
        } catch (ComputeEgressService.EgressRefused e) {
            return error(HttpStatus.CONFLICT, e.reason());
        }
    }

    /** 呼んだプラグインの行だけ（他のプラグインの行は返さない）。 */
    @GetMapping("/api/plugins/{id}/compute/jobs")
    public ResponseEntity<?> jobs(@PathVariable String id, @RequestParam(required = false) String batchId,
                                  @RequestParam(required = false, defaultValue = "false") boolean uncollectedOnly) {
        PluginManifest m = manifest(id);
        if (m == null) {
            return error(HttpStatus.NOT_FOUND, "unknown-plugin");
        }
        if (!permitted(m)) {
            return error(HttpStatus.FORBIDDEN, "permission-denied");
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (ComputeJobRecord j : ledger.list()) {
            if (!ownedBy(j, id) || (batchId != null && !batchId.equals(j.batchId))
                    || (uncollectedOnly && !(ComputeJobStateMachine.State.valueOf(j.state)
                    == ComputeJobStateMachine.State.DONE && j.collectedAt == null))) {
                continue;
            }
            out.add(ledger.view(j));
        }
        return ResponseEntity.ok(out);
    }

    /** 結果を受け取った印（窓の「受け取り済み」）。自分のプラグインの終わった行だけ。 */
    @PostMapping("/api/plugins/{id}/compute/jobs/{jobId}/collected")
    public ResponseEntity<Map<String, Object>> collected(@PathVariable String id, @PathVariable String jobId) {
        ResponseEntity<Map<String, Object>> denied = guard(id, jobId);
        if (denied != null) {
            return denied;
        }
        return ledger.markCollected(jobId) ? ResponseEntity.ok(Map.of("ok", true))
                : error(HttpStatus.CONFLICT, "not-finished");
    }

    /** 台帳のジョブのフォルダにある結果（outputs.zip）。H53 の 1 時間の保管に頼らず、窓を閉じた後でも受け取れる。 */
    @GetMapping("/api/plugins/{id}/compute/jobs/{jobId}/artifact")
    public ResponseEntity<?> artifact(@PathVariable String id, @PathVariable String jobId) {
        ResponseEntity<Map<String, Object>> denied = guard(id, jobId);
        if (denied != null) {
            return denied;
        }
        Path zip = ledger.jobDir(jobId).resolve("outputs.zip");
        if (!Files.isRegularFile(zip)) {
            return error(HttpStatus.NOT_FOUND, "no-artifact");
        }
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("application/zip"))
                .body(new FileSystemResource(zip));
    }

    /** 台帳のログの全文（stdout / stderr / traceback）。自分のプラグインの行だけ。無ければ空の本文。 */
    @GetMapping(value = "/api/plugins/{id}/compute/jobs/{jobId}/log/{kind}",
            produces = MediaType.TEXT_PLAIN_VALUE + ";charset=UTF-8")
    public ResponseEntity<?> log(@PathVariable String id, @PathVariable String jobId, @PathVariable String kind) {
        ResponseEntity<Map<String, Object>> denied = guard(id, jobId);
        if (denied != null) {
            return ResponseEntity.status(denied.getStatusCode()).build(); // text/plain の口なので本文は付けない
        }
        return ledger.readLog(jobId, kind).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** 一時停止（計算機に届かない）から続ける。待ちのままの組を元の順で並べ直す。 */
    @PostMapping("/api/compute/batches/{batchId}/resume")
    public ResponseEntity<Map<String, Object>> resume(@PathVariable String batchId) {
        if (!BATCH_ID.matcher(batchId).matches()) {
            return ResponseEntity.notFound().build();
        }
        int n = runner.resumeBatch(batchId);
        return n < 0 ? error(HttpStatus.CONFLICT, "not-resumable") : ResponseEntity.ok(Map.of("requeued", n));
    }

    /** 一括を中止する（待ちの組は何も送らずに中止・実行中は中断）。 */
    @PostMapping("/api/compute/batches/{batchId}/cancel")
    public ResponseEntity<Map<String, Object>> cancel(@PathVariable String batchId) {
        if (!BATCH_ID.matcher(batchId).matches()) {
            return ResponseEntity.notFound().build();
        }
        int n = runner.cancelBatch(batchId);
        return n < 0 ? error(HttpStatus.CONFLICT, "not-cancellable") : ResponseEntity.accepted().body(Map.of("cancelled", n));
    }

    private ResponseEntity<Map<String, Object>> guard(String pluginId, String jobId) {
        PluginManifest m = manifest(pluginId);
        if (m == null) {
            return error(HttpStatus.NOT_FOUND, "unknown-plugin");
        }
        if (!permitted(m)) {
            return error(HttpStatus.FORBIDDEN, "permission-denied");
        }
        if (!JOB_ID.matcher(jobId).matches()) {
            return error(HttpStatus.NOT_FOUND, "unknown-job");
        }
        ComputeJobRecord j = ledger.find(jobId).orElse(null);
        if (j == null || !ownedBy(j, pluginId)) {
            return error(HttpStatus.NOT_FOUND, "unknown-job"); // 他のプラグインの行は「無い」と同じ答え
        }
        return null;
    }

    private boolean ownedBy(ComputeJobRecord j, String pluginId) {
        return ledger.batchOf(j).map(b -> pluginId.equals(b.pluginId)).orElse(false);
    }

    private PluginManifest manifest(String id) {
        return plugins.manifests().stream().filter(x -> x.id().equals(id)).findFirst().orElse(null);
    }

    private static boolean permitted(PluginManifest m) {
        return m.permissions() != null && m.permissions().contains(ComputeEgressController.PERMISSION);
    }

    private static ResponseEntity<Map<String, Object>> error(HttpStatus s, String reason) {
        return ResponseEntity.status(s).body(Map.of("ok", false, "error", reason));
    }
}
