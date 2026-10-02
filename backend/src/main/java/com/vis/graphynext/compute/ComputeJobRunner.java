/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.plugin.PluginArtifacts;
import com.vis.graphynext.plugin.PluginJobService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 承認済みの要求を外部の計算機で実行する（H59 {@code compute.runJob}）。設計: fw/remote-compute-design.md §5。
 *
 * <p>🔑 <b>ジョブの仕組みは既存の {@link PluginJobService#submitTask} に乗せる。</b> 進み具合・取り消し・
 * 状態の問い合わせ（{@code /api/plugin-jobs/{jobId}}）はプラグインの JAR のジョブと同じ。
 * 結果のファイルは {@code outputs.zip} にまとめて H53 の成果物（{@link PluginArtifacts}）にする。
 *
 * <h3>計算機の上の配置</h3>
 * {@code graphy/<run>/inputs/0.npz …} にデータを置き、カーネルを {@code graphy/<run>} で起動する。
 * コードは相対パスで {@code inputs/} を読み、{@code outputs/} に書く。終わったら（失敗・取り消しでも）
 * フォルダごと消してカーネルを止める——<b>匿名化済みとはいえ患者由来のデータを計算機に残さない</b>。
 */
@Service
public class ComputeJobRunner {

    private static final Logger log = LoggerFactory.getLogger(ComputeJobRunner.class);
    /** 取り出す結果の上限（ファイル数・合計）。 */
    static final int MAX_OUTPUT_FILES = 64;
    static final long MAX_OUTPUT_BYTES = 512L * 1024 * 1024;
    /** 中断してから止まるのを待つ時間。過ぎたらカーネルごと止める（Windows のカーネルは長い待ちを中断できない）。 */
    static final Duration INTERRUPT_GRACE = Duration.ofSeconds(10);
    static final int DEFAULT_TIMEOUT_SEC = 3600;
    static final int MAX_TIMEOUT_SEC = 6 * 3600;
    /** コードが進み具合を伝える行: {@code print("__progress__", 0.4, "message")}。 */
    static final Pattern PROGRESS = Pattern.compile("__progress__\\s+([0-9.eE+-]+)\\s*(.*)");

    private final ComputeEgressService egress;
    private final ComputeEndpointRegistry endpoints;
    private final ComputeDatasetService datasets;
    private final ComputeAuditLog audit;
    private final PluginJobService jobs;
    private final ObjectMapper mapper;

    public ComputeJobRunner(ComputeEgressService egress, ComputeEndpointRegistry endpoints,
                            ComputeDatasetService datasets, ComputeAuditLog audit, PluginJobService jobs,
                            ObjectMapper mapper) {
        this.egress = egress;
        this.endpoints = endpoints;
        this.datasets = datasets;
        this.audit = audit;
        this.jobs = jobs;
        this.mapper = mapper;
    }

    /**
     * 承認済みの要求を使ってジョブを投入する。<b>札はここで使用済みになる</b>（同じ承認で 2 回は走らない）。
     *
     * @throws ComputeEgressService.EgressRefused 承認されていない・期限切れ・使用済み・別のプラグインの要求
     */
    public PluginJobService.Status submit(String pluginId, String requestId, Integer timeoutSec) {
        ComputeEgressService.EgressRequest r = egress.consumeFor(pluginId, requestId)
                .orElseThrow(() -> new ComputeEgressService.EgressRefused("not-approved"));
        int timeout = timeoutSec == null ? DEFAULT_TIMEOUT_SEC : Math.max(10, Math.min(MAX_TIMEOUT_SEC, timeoutSec));
        return jobs.submitTask(pluginId, ctx -> run(r, Duration.ofSeconds(timeout), ctx));
    }

    Map<String, Object> run(ComputeEgressService.EgressRequest r, Duration timeout,
                            PluginJobService.TaskContext ctx) throws Exception {
        long t0 = System.nanoTime();
        JupyterServerClient c = endpoints.client(r.endpointId(), mapper)
                .orElseThrow(() -> new IllegalStateException("endpoint no longer registered: " + r.endpointId()));
        String runDir = "graphy/" + UUID.randomUUID().toString().substring(0, 12);
        String kernelId = null;
        String outcome = "failed";
        Map<String, Object> result = new LinkedHashMap<>();
        try {
            // 1. データを置く
            ctx.progress().accept(0.02, "upload");
            c.mkdirs(runDir + "/outputs");
            List<ComputeEgressService.DatasetSummary> ds = r.datasets();
            long sent = 0;
            for (int i = 0; i < ds.size(); i++) {
                checkCancel(ctx);
                ComputeDatasetService.Dataset d = datasets.get(ds.get(i).handle())
                        .orElseThrow(() -> new IllegalStateException("dataset expired"));
                byte[] bytes = Files.readAllBytes(d.file());
                if (!ComputeEgressService.sha256Hex(bytes).equals(ds.get(i).sha256())) {
                    throw new IllegalStateException("dataset changed after approval"); // 承認した中身と違うものは送らない
                }
                c.upload(runDir + "/inputs/" + i + d.format().extension, bytes);
                sent += bytes.length;
                ctx.progress().accept(0.02 + 0.18 * (i + 1) / ds.size(), "upload");
            }
            audit.append(event("compute-uploaded", r).put("bytes", sent));

            // 2. 実行する
            checkCancel(ctx);
            ctx.progress().accept(0.2, "start");
            kernelId = c.startKernel(null, runDir);
            ExecutionResult er;
            try (KernelChannel ch = c.connect(kernelId, Duration.ofSeconds(120))) {
                CompletableFuture<ExecutionResult> f = ch.execute(r.code(), (name, text) -> progressFrom(text, ctx));
                er = await(f, c, kernelId, timeout, ctx);
            }
            result.put("status", er.status());
            result.put("stdout", er.stdout());
            result.put("stderr", er.stderr());
            if (!er.ok()) {
                result.put("errorName", er.errorName());
                result.put("errorValue", er.errorValue());
                result.put("traceback", er.traceback());
            }

            // 3. 結果を取り出す（エラーでも途中までの outputs は返す）
            ctx.progress().accept(0.95, "download");
            List<Map<String, Object>> files = new ArrayList<>();
            Path zip = collectOutputs(c, runDir + "/outputs", files);
            result.put("files", files);
            if (zip != null) {
                result.put(PluginArtifacts.ARTIFACT_KEY, zip.toString());
                result.put(PluginArtifacts.ARTIFACT_NAME_KEY, "outputs.zip");
            }
            outcome = er.ok() ? "ok" : "error";
            ctx.progress().accept(1.0, "done");
            return result;
        } catch (CancelledByUser e) {
            outcome = "cancelled";
            throw e;
        } finally {
            if (kernelId != null) {
                try {
                    c.shutdownKernel(kernelId);
                } catch (RuntimeException e) {
                    log.warn("[compute] cannot shut down kernel: {}", e.getMessage());
                }
            }
            try {
                c.delete(runDir); // 計算機に患者由来のデータを残さない
            } catch (RuntimeException e) {
                log.warn("[compute] cannot delete remote folder {}: {}", runDir, e.getMessage());
                outcome = outcome + "+remote-cleanup-failed";
            }
            r.datasets().forEach(d -> datasets.discard(d.handle()));
            @SuppressWarnings("unchecked")
            List<Object> files = (List<Object>) result.getOrDefault("files", List.of());
            audit.append(event("compute-finished", r).put("outcome", outcome)
                    .put("durationMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0))
                    .put("outputFiles", files.size()));
        }
    }

    /** 実行の終わりを待つ。取り消し・時間切れなら中断し、止まらなければカーネルを止める。 */
    private ExecutionResult await(CompletableFuture<ExecutionResult> f, JupyterServerClient c, String kernelId,
                                  Duration timeout, PluginJobService.TaskContext ctx) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (true) {
            try {
                return f.get(500, TimeUnit.MILLISECONDS);
            } catch (TimeoutException ignored) {
                // 続けて待つ
            }
            boolean cancelled = ctx.cancelled().getAsBoolean();
            if (cancelled || System.nanoTime() > deadline) {
                c.interruptKernel(kernelId);
                try {
                    f.get(INTERRUPT_GRACE.toMillis(), TimeUnit.MILLISECONDS);
                } catch (TimeoutException e) {
                    c.shutdownKernel(kernelId);
                }
                if (cancelled) {
                    throw new CancelledByUser();
                }
                throw new IllegalStateException("timeout after " + timeout.toSeconds() + "s");
            }
        }
    }

    private static void progressFrom(String text, PluginJobService.TaskContext ctx) {
        for (String line : text.split("\n")) {
            Matcher m = PROGRESS.matcher(line.strip());
            if (m.find()) {
                try {
                    double p = Double.parseDouble(m.group(1));
                    ctx.progress().accept(0.2 + 0.75 * Math.max(0, Math.min(1, p)), m.group(2).strip());
                } catch (NumberFormatException ignored) {
                    // 読めない進み具合は無視する
                }
            }
        }
    }

    /**
     * {@code outputs/} を（下の階層も含めて）取り出し、無圧縮の zip にする。
     * 無圧縮にするのは、プラグイン側（ブラウザ）で依存なしに 1 ファイルずつ取り出せるようにするため。
     *
     * @return zip のパス（一時フォルダの下。H53 が預かる）。outputs が空なら null
     */
    private Path collectOutputs(JupyterServerClient c, String dir, List<Map<String, Object>> files)
            throws IOException {
        List<String> names = new ArrayList<>();
        listFiles(c, dir, "", names);
        if (names.isEmpty()) {
            return null;
        }
        if (names.size() > MAX_OUTPUT_FILES) {
            throw new IllegalStateException("too many output files: " + names.size());
        }
        Path zip = Files.createTempFile("graphy-compute-outputs-", ".zip");
        long total = 0;
        try (OutputStream fo = Files.newOutputStream(zip); ZipOutputStream z = new ZipOutputStream(fo)) {
            z.setMethod(ZipOutputStream.STORED);
            for (String name : names) {
                byte[] b = c.download(dir + "/" + name);
                if (b == null) {
                    continue;
                }
                total += b.length;
                if (total > MAX_OUTPUT_BYTES) {
                    throw new IllegalStateException("outputs too large");
                }
                ZipEntry e = new ZipEntry(name);
                CRC32 crc = new CRC32();
                crc.update(b);
                e.setMethod(ZipEntry.STORED);
                e.setSize(b.length);
                e.setCompressedSize(b.length);
                e.setCrc(crc.getValue());
                z.putNextEntry(e);
                z.write(b);
                z.closeEntry();
                files.add(Map.of("name", name, "size", (long) b.length));
            }
        }
        return zip;
    }

    private static void listFiles(JupyterServerClient c, String base, String rel, List<String> out) {
        for (JsonNode n : c.list(rel.isEmpty() ? base : base + "/" + rel)) {
            String name = n.path("name").asText();
            String path = rel.isEmpty() ? name : rel + "/" + name;
            if ("directory".equals(n.path("type").asText())) {
                listFiles(c, base, path, out);
            } else {
                out.add(path);
            }
            if (out.size() > MAX_OUTPUT_FILES) {
                return;
            }
        }
    }

    private static void checkCancel(PluginJobService.TaskContext ctx) {
        if (ctx.cancelled().getAsBoolean()) {
            throw new CancelledByUser();
        }
    }

    private ObjectNode event(String type, ComputeEgressService.EgressRequest r) {
        return audit.event(type).put("requestId", r.id()).put("pluginId", r.pluginId())
                .put("endpointId", r.endpointId()).put("codeSha256", r.codeSha256());
    }

    /** 利用者の取り消し（ジョブは CANCELLED になる）。 */
    static final class CancelledByUser extends RuntimeException {
        CancelledByUser() {
            super("cancelled");
        }
    }
}
