/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

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

/**
 * プラグインが外部の計算機へ送る要求を作る口。設計: fw/remote-compute-design.md §4.2・§5。
 *
 * <p>ここでは<b>何も送らない</b>。データセットを（既存の匿名化で）作り、内容を確定した要求を返すだけ。
 * 送ってよいかは main が自分のウィンドウで利用者に聞く（{@code compute:confirm}）。
 *
 * <p>🔴 <b>permission は backend で確かめる</b>（{@code ai-egress} のようにフロントだけで見ない）。
 * プラグインの id はパスで渡るが、レンダラは任意の id を名乗れるので、これは「宣言していないプラグインが
 * 誤って使う」のを止めるもの。悪意のあるプラグインは main の同意画面（プラグイン名・宛先・コード全文）で止める。
 */
@RestController
@Profile("standalone")
public class ComputeEgressController {

    static final String PERMISSION = "remote-compute";

    private final PluginRegistry plugins;
    private final ComputeDatasetService datasets;
    private final ComputeEgressService egress;
    private final ComputeJobRunner runner;

    public ComputeEgressController(PluginRegistry plugins, ComputeDatasetService datasets,
                                   ComputeEgressService egress, ComputeJobRunner runner) {
        this.plugins = plugins;
        this.datasets = datasets;
        this.egress = egress;
        this.runner = runner;
    }

    public record Input(String studyUid, String seriesUid, String format) {
    }

    public record EgressBody(String endpointId, List<Input> inputs, String code) {
    }

    @PostMapping("/api/plugins/{id}/compute/egress")
    public ResponseEntity<Map<String, Object>> create(@PathVariable String id, @RequestBody EgressBody body) {
        PluginManifest m = plugins.manifests().stream().filter(x -> x.id().equals(id)).findFirst().orElse(null);
        if (m == null) {
            return error(HttpStatus.NOT_FOUND, "unknown-plugin");
        }
        String endpointId = body == null ? null : body.endpointId();
        if (m.permissions() == null || !m.permissions().contains(PERMISSION)) {
            egress.refused(id, endpointId, "permission-denied");
            return error(HttpStatus.FORBIDDEN, "permission-denied");
        }
        if (body == null || body.inputs() == null || body.inputs().isEmpty() || body.inputs().size() > 8) {
            return error(HttpStatus.BAD_REQUEST, "bad-inputs");
        }
        // 宛先とコードはデータセットを作る前に確かめる（作ってから断ると匿名化が無駄になる）。弾いたら監査に残る
        String problem = egress.precheck(id, endpointId, body.code(), CodeInspector.MAX_JOB_CHARS);
        if (problem != null) {
            return error(HttpStatus.UNPROCESSABLE_ENTITY, problem);
        }
        List<String> handles = new ArrayList<>();
        try {
            for (Input in : body.inputs()) {
                ComputeDatasetService.Format f = ComputeDatasetService.Format.of(in.format() == null ? "npz" : in.format())
                        .orElseThrow(() -> new ComputeDatasetService.DatasetRefused("bad-format", in.format()));
                handles.add(datasets.create(in.studyUid(), in.seriesUid(), f).handle());
            }
            ComputeEgressService.EgressRequest r = egress.create(m.id(), m.name(), body.endpointId(), handles,
                    body.code(), CodeInspector.MAX_JOB_CHARS);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("requestId", r.id());
            out.put("endpoint", Map.of("id", r.endpointId(), "label", r.endpointLabel()));
            out.put("datasets", r.datasets());
            out.put("codeSha256", r.codeSha256());
            return ResponseEntity.ok(out);
        } catch (ComputeDatasetService.DatasetRefused e) {
            handles.forEach(datasets::discard);
            return error(HttpStatus.UNPROCESSABLE_ENTITY, e.reason());
        } catch (ComputeEgressService.EgressRefused e) {
            handles.forEach(datasets::discard);
            return error(HttpStatus.UNPROCESSABLE_ENTITY, e.reason());
        } catch (RuntimeException e) {
            handles.forEach(datasets::discard);
            throw e;
        }
    }

    public record JobBody(String requestId, Integer timeoutSec) {
    }

    /**
     * 承認済みの要求を実行する（H59）。<b>承認の札はここで使用済みになる。</b>
     * 進み具合・結果・取り消しは既存の {@code /api/plugin-jobs/{jobId}}（H45）で扱う。
     */
    @PostMapping("/api/plugins/{id}/compute/jobs")
    public ResponseEntity<?> run(@PathVariable String id, @RequestBody JobBody body) {
        PluginManifest m = plugins.manifests().stream().filter(x -> x.id().equals(id)).findFirst().orElse(null);
        if (m == null) {
            return error(HttpStatus.NOT_FOUND, "unknown-plugin");
        }
        if (m.permissions() == null || !m.permissions().contains(PERMISSION)) {
            egress.refused(id, null, "permission-denied");
            return error(HttpStatus.FORBIDDEN, "permission-denied");
        }
        try {
            return ResponseEntity.ok(runner.submit(id, body == null ? null : body.requestId(),
                    body == null ? null : body.timeoutSec()));
        } catch (ComputeEgressService.EgressRefused e) {
            return error(HttpStatus.CONFLICT, e.reason());
        }
    }

    private static ResponseEntity<Map<String, Object>> error(HttpStatus s, String reason) {
        return ResponseEntity.status(s).body(Map.of("ok", false, "error", reason));
    }
}
