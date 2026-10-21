/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.compute.ComputeJobStateMachine.Reason;
import com.vis.graphynext.compute.ComputeJobStateMachine.State;
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
import java.util.concurrent.ConcurrentHashMap;
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
 *
 * <h3>台帳と待ち行列</h3>
 * ジョブは {@link ComputeJobLedger}（H2）に 1 行残り、状態は待ち → 実行中 → 完了／失敗／中止と移る。
 * <b>同じ計算機のジョブは 1 本ずつ順に</b>走る（同じ GPU に同時 2 カーネルを立てない。別の計算機は待たない）。
 * プラグインから見た H59（{@code /api/plugin-jobs/{jobId}}・成果物の取り方）は変わらない。
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
    private final ComputeJobLedger ledger;

    public ComputeJobRunner(ComputeEgressService egress, ComputeEndpointRegistry endpoints,
                            ComputeDatasetService datasets, ComputeAuditLog audit, PluginJobService jobs,
                            ObjectMapper mapper, ComputeJobLedger ledger) {
        this.egress = egress;
        this.endpoints = endpoints;
        this.datasets = datasets;
        this.audit = audit;
        this.jobs = jobs;
        this.mapper = mapper;
        this.ledger = ledger;
        // 結果の zip は台帳のジョブのフォルダに置き、H53 はそこを指す（移さない）
        jobs.artifacts().trustRoot(ledger.jobsRoot());
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
        List<ComputeJobLedger.InputRef> inputs = r.datasets().stream()
                .map(d -> datasets.get(d.handle())
                        .map(ds -> new ComputeJobLedger.InputRef(ds.sourceStudyUid(), ds.sourceSeriesUid(), d.format()))
                        .orElse(new ComputeJobLedger.InputRef("", "", d.format())))
                .toList();
        String cj = ledger.create(r, inputs, timeout);
        PluginJobService.Status st = jobs.submitSerialTask(r.endpointId(), pluginId, new PluginJobService.Task() {
            @Override
            public Object run(PluginJobService.TaskContext ctx) throws Exception {
                return ComputeJobRunner.this.run(r, cj, Duration.ofSeconds(timeout), ctx);
            }

            @Override
            public void onCancelRequested() {
                cancelQueued(cj, r);
            }
        });
        ledger.attachPluginJob(cj, st.jobId());
        return st;
    }

    /**
     * 利用者の取り消し（台帳の行から）。順番待ちなら計算機へ何も送らずに中止、実行中なら中断して止める。
     *
     * @return 取り消しを受け付けたか（行が無い・もう終わっていれば false）
     */
    public boolean cancel(String jobId) {
        ComputeJobRecord j = ledger.find(jobId).orElse(null);
        if (j == null || State.valueOf(j.state).ended() || j.pluginJobId == null) {
            return false;
        }
        return jobs.cancel(j.pluginJobId).isPresent();
    }

    // ── 一括（同じコードを組ごとの入力で走らせる。同意は 1 回） ──

    /** 承認済みの一括の、メモリ上の持ち物（再起動で消える＝再開は新しい同意から）。 */
    private static final class BatchCtx {
        final String batchId;
        final ComputeEgressService.EgressRequest request;
        final Duration timeout;
        /** 低優先（一括の組）で並べるか。対話の 1 回の再実行は通常の優先度。 */
        final boolean low;
        /** 組（ジョブ id → 組）。作った順＝列に並べる順。 */
        final Map<String, ComputeEgressService.Item> items = new LinkedHashMap<>();
        /** ジョブごとの世代。列へ並べ直したとき古い待ちの実行を無効にする（二重に走らせない）。 */
        final Map<String, java.util.concurrent.atomic.AtomicInteger> generation = new ConcurrentHashMap<>();

        BatchCtx(String batchId, ComputeEgressService.EgressRequest request, Duration timeout, boolean low) {
            this.batchId = batchId;
            this.request = request;
            this.timeout = timeout;
            this.low = low;
        }
    }

    private final Map<String, BatchCtx> batches = new ConcurrentHashMap<>();

    /**
     * 承認済みの一括を投入する。<b>札は全組でここで 1 回だけ使用済みになる。</b>
     * 組ごとにジョブ（台帳の行）を作り、同じ計算機の列に（対話のジョブより後ろに）並べる。
     *
     * @return {@code batchId} と、組名 → ジョブ id
     * @throws ComputeEgressService.EgressRefused 承認されていない・期限切れ・使用済み・別のプラグインの要求
     */
    public Map<String, Object> submitBatch(String pluginId, String requestId, Integer timeoutSec) {
        ComputeEgressService.EgressRequest r = egress.consumeFor(pluginId, requestId)
                .orElseThrow(() -> new ComputeEgressService.EgressRefused("not-approved"));
        int timeout = timeoutSec == null ? DEFAULT_TIMEOUT_SEC : Math.max(10, Math.min(MAX_TIMEOUT_SEC, timeoutSec));
        // 待ちの組のデータを期限（2 時間）で消さない。その組が終わるか一括が中止されるまで持つ
        r.datasets().forEach(d -> datasets.hold(d.handle()));
        String batchId = ledger.createBatch(r, timeout, false);
        BatchCtx bc = new BatchCtx(batchId, r, Duration.ofSeconds(timeout), true);
        List<Map<String, Object>> out = new ArrayList<>();
        for (ComputeEgressService.Item it : r.itemsOrSingle()) {
            List<ComputeJobLedger.InputRef> inputs = it.datasets().stream()
                    .map(d -> datasets.get(d.handle())
                            .map(ds -> new ComputeJobLedger.InputRef(ds.sourceStudyUid(), ds.sourceSeriesUid(), d.format()))
                            .orElse(new ComputeJobLedger.InputRef("", "", d.format())))
                    .toList();
            String cj = ledger.createJob(batchId, r, it.key(), inputs);
            bc.items.put(cj, it);
            out.add(Map.of("key", it.key() == null ? "" : it.key(), "jobId", cj));
        }
        batches.put(batchId, bc);
        bc.items.keySet().forEach(cj -> enqueueItem(bc, cj));
        return Map.of("batchId", batchId, "items", out);
    }

    /** 1 組を計算機の列（低優先）へ並べる。世代を進めるので、前に並べた同じ組の待ちは何もせず終わる。 */
    private void enqueueItem(BatchCtx bc, String cj) {
        ComputeEgressService.EgressRequest ir = bc.request.forItem(bc.items.get(cj));
        int gen = bc.generation.computeIfAbsent(cj, k -> new java.util.concurrent.atomic.AtomicInteger()).incrementAndGet();
        PluginJobService.Task task = new PluginJobService.Task() {
            @Override
            public Object run(PluginJobService.TaskContext ctx) throws Exception {
                if (bc.generation.get(cj).get() != gen) {
                    return Map.of("superseded", true); // 並べ直された（今の待ちが走る）
                }
                if (ledger.isPaused(bc.batchId)) {
                    return Map.of("parked", true); // 一時停止中。台帳は待ちのまま・データは保持（再開で並べ直す）
                }
                return ComputeJobRunner.this.run(ir, cj, bc.timeout, ctx);
            }

            @Override
            public void onCancelRequested() {
                cancelQueued(cj, ir);
            }
        };
        PluginJobService.Status st = bc.low ? jobs.submitSerialTaskLow(ir.endpointId(), ir.pluginId(), task)
                : jobs.submitSerialTask(ir.endpointId(), ir.pluginId(), task);
        ledger.attachPluginJob(cj, st.jobId());
    }

    /**
     * 再実行を投入する。<b>承認の札（再実行の要求）はここで使用済みになる</b>——前の実行の承認は使えず、毎回の同意が要る。
     * 記録のバッチの中に、同じ組の次の試行（{@code attempt + 1}）として並べる。1 件の再実行（対話の 1 回）は通常の優先度、
     * 一括の失敗だけの再実行は低優先度。
     *
     * @return {@code batchId} と、組名 → ジョブ id・試行の番号
     * @throws ComputeEgressService.EgressRefused 承認されていない・期限切れ・使用済み・再実行の札でない・動いている組がある
     */
    public Map<String, Object> submitRerun(String requestId, Integer timeoutSec) {
        ComputeEgressService.EgressRequest r = egress.consumeRerun(requestId)
                .orElseThrow(() -> new ComputeEgressService.EgressRefused("not-approved"));
        String batchId = r.rerun().get("batchId");
        ComputeBatchRecord batch = ledger.batchRecord(batchId).orElse(null);
        if (batch == null || ledger.hasActive(batchId)) {
            // 承認してから投入までのあいだに、台帳の行が消えた・別の実行が始まった。送らずにデータを捨てる
            r.datasets().forEach(d -> datasets.discard(d.handle()));
            throw new ComputeEgressService.EgressRefused(batch == null ? "unknown-batch" : "batch-active");
        }
        int timeout = timeoutSec == null ? Math.max(10, Math.min(MAX_TIMEOUT_SEC, batch.timeoutSec))
                : Math.max(10, Math.min(MAX_TIMEOUT_SEC, timeoutSec));
        r.datasets().forEach(d -> datasets.hold(d.handle()));
        ledger.resumeBatch(batchId); // 前の一時停止の印は残さない
        List<ComputeEgressService.Item> items = r.itemsOrSingle();
        BatchCtx bc = new BatchCtx(batchId, r, Duration.ofSeconds(timeout), !batch.interactive || items.size() > 1);
        List<Map<String, Object>> out = new ArrayList<>();
        for (ComputeEgressService.Item it : items) {
            List<ComputeJobLedger.InputRef> inputs = it.datasets().stream()
                    .map(d -> datasets.get(d.handle())
                            .map(ds -> new ComputeJobLedger.InputRef(ds.sourceStudyUid(), ds.sourceSeriesUid(), d.format()))
                            .orElse(new ComputeJobLedger.InputRef("", "", d.format())))
                    .toList();
            int attempt = ledger.nextAttempt(batchId, it.key());
            String cj = ledger.createJob(batchId, r, it.key(), inputs, attempt);
            bc.items.put(cj, it);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", it.key() == null ? "" : it.key());
            row.put("jobId", cj);
            row.put("attempt", attempt);
            out.add(row);
        }
        batches.put(batchId, bc);
        bc.items.keySet().forEach(cj -> enqueueItem(bc, cj));
        return Map.of("batchId", batchId, "items", out);
    }

    /**
     * 一時停止中の一括を再開する。待ちのままの組を、元の順で列へ並べ直す。
     *
     * @return 並べ直した組の数。一括が見つからない（再起動で失われた）・一時停止でなければ -1
     */
    public int resumeBatch(String batchId) {
        BatchCtx bc = batches.get(batchId);
        if (bc == null || !ledger.isPaused(batchId)) {
            return -1;
        }
        ledger.resumeBatch(batchId);
        int n = 0;
        for (String cj : bc.items.keySet()) {
            ComputeJobRecord j = ledger.find(cj).orElse(null);
            if (j != null && State.valueOf(j.state) == State.QUEUED) {
                enqueueItem(bc, cj);
                n++;
            }
        }
        return n;
    }

    /**
     * 一括を中止する。待ちの組は計算機へ何も送らずに中止、実行中の組は中断する。
     *
     * @return 中止を受け付けた組の数。一括が見つからなければ -1（再起動で失われた行は中断になっている）
     */
    public int cancelBatch(String batchId) {
        BatchCtx bc = batches.get(batchId);
        if (bc == null) {
            return -1;
        }
        int n = 0;
        for (Map.Entry<String, ComputeEgressService.Item> e : bc.items.entrySet()) {
            ComputeJobRecord j = ledger.find(e.getKey()).orElse(null);
            if (j == null || State.valueOf(j.state).ended()) {
                continue;
            }
            if (cancel(e.getKey())) {
                n++;
            } else if (ledger.cancelIfQueued(e.getKey())) {
                // 並べた待ちのジョブが一覧から消えている（一時停止が長引いた）。台帳とデータをここで片付ける
                bc.request.forItem(e.getValue()).datasets().forEach(d -> datasets.discard(d.handle()));
                audit.append(event("compute-job-cancelled", bc.request.forItem(e.getValue())).put("stage", "queued"));
                n++;
            }
        }
        ledger.resumeBatch(batchId); // 中止したので「一時停止」の表示は残さない
        releaseIfDone(batchId);
        return n;
    }

    /** 組が終わるたびに呼ぶ。全部終わったら、メモリの持ち物を手放す。 */
    private void releaseIfDone(String batchId) {
        BatchCtx bc = batches.get(batchId);
        if (bc != null && ledger.jobsOfBatch(batchId).stream().allMatch(j -> State.valueOf(j.state).ended())) {
            batches.remove(batchId);
        }
    }

    /** 待ちのままなら中止にして、送らずに終える（データは捨てる）。実行が始まっていれば何もしない。 */
    private void cancelQueued(String cj, ComputeEgressService.EgressRequest r) {
        if (ledger.cancelIfQueued(cj)) {
            r.datasets().forEach(d -> datasets.discard(d.handle()));
            audit.append(event("compute-job-cancelled", r).put("stage", "queued"));
        }
    }

    /** 1 件の実行。台帳へ「実行中」を書き、終わったら完了・失敗・中止を書く。 */
    Map<String, Object> run(ComputeEgressService.EgressRequest r, String cj, Duration timeout,
                            PluginJobService.TaskContext ctx) throws Exception {
        if (!ledger.start(cj, null)) {
            // 待ちの間に中止された（cancelQueued がデータを捨てている）
            throw new CancelledByUser();
        }
        PluginJobService.TaskContext lctx = new PluginJobService.TaskContext((p, m) -> {
            ctx.progress().accept(p, m);
            if (p != null) {
                ledger.progress(cj, phaseOf(m), Math.max(0, Math.min(1, p)), m);
            }
        }, ctx.cancelled());
        try {
            Map<String, Object> result = runOnRemote(r, cj, timeout, lctx);
            recordEnd(cj, result);
            return result;
        } catch (CancelledByUser e) {
            ledger.finish(cj, State.CANCELLED, null, null, null, 0);
            audit.append(event("compute-job-cancelled", r).put("stage", "running"));
            throw e;
        } catch (Exception e) {
            Reason reason = ComputeJobStateMachine.classify(e);
            ledger.finish(cj, State.FAILED, reason, e.getClass().getSimpleName(), e.getMessage(), 0);
            pauseIfUnreachable(cj, reason, r);
            throw e;
        } finally {
            ledger.find(cj).ifPresent(j -> releaseIfDone(j.batchId));
        }
    }

    /**
     * 🔑 障害と入力固有の失敗を分ける: 計算機に届かないのは入力のせいではないので、一括の残りを失敗にせず<b>一時停止</b>する。
     * 対話の 1 回は対象外（1 本だけで、利用者がやり直す）。
     */
    private void pauseIfUnreachable(String cj, Reason reason, ComputeEgressService.EgressRequest r) {
        if (reason != Reason.ENDPOINT_UNREACHABLE) {
            return;
        }
        ledger.find(cj).flatMap(ledger::batchOf).filter(b -> !b.interactive).ifPresent(b -> {
            ledger.pauseBatch(b.id, Reason.ENDPOINT_UNREACHABLE.code);
            audit.append(event("compute-batch-paused", r).put("reason", Reason.ENDPOINT_UNREACHABLE.code));
        });
    }

    /** コードの結果（正常終了・Python の例外）を台帳へ。例外でも H59 の戻り値は今のまま（status:"error"）。 */
    private void recordEnd(String cj, Map<String, Object> result) {
        ledger.writeLogs(cj, str(result.get("stdout")), str(result.get("stderr")), str(result.get("traceback")));
        long bytes = 0;
        if (result.get(PluginArtifacts.ARTIFACT_KEY) instanceof String zip) {
            try {
                bytes = Files.size(Path.of(zip));
            } catch (IOException ignored) {
                // 大きさが分からないだけ（0 のまま）
            }
        }
        if ("ok".equals(result.get("status"))) {
            ledger.finish(cj, State.DONE, null, null, null, bytes);
        } else {
            ledger.finish(cj, State.FAILED, Reason.CODE_ERROR, str(result.get("errorName")),
                    str(result.get("errorValue")), bytes);
        }
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static String phaseOf(String message) {
        return switch (message == null ? "" : message) {
            case "upload" -> "upload";
            case "start" -> "start";
            case "download" -> "download";
            case "done" -> "cleanup";
            default -> "exec";
        };
    }

    private Map<String, Object> runOnRemote(ComputeEgressService.EgressRequest r, String cj, Duration timeout,
                                            PluginJobService.TaskContext ctx) throws Exception {
        long t0 = System.nanoTime();
        JupyterServerClient c = endpoints.client(r.endpointId(), mapper)
                .orElseThrow(() -> new IllegalStateException("endpoint no longer registered: " + r.endpointId()));
        // 承認した送り先と実行時の接続先が同じか。違えば（承認のあとに登録簿が入れ替わった）送らない。
        // 自機では Jupyter の起動し直しでポートが変わるので、起こりやすい
        if (!c.endpoint().base().toString().equals(r.endpointUrl())) {
            audit.append(event("egress-destination-changed", r).put("approvedHost", hostOf(r.endpointUrl()))
                    .put("actualHost", c.endpoint().base().getAuthority()));
            throw new IllegalStateException("destination-changed");
        }
        String runDir = c.endpoint().workRoot() + "/" + UUID.randomUUID().toString().substring(0, 12);
        ledger.remoteRunDir(cj, runDir);
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
            ledger.kernelId(cj, kernelId);
            ExecutionResult er;
            try (KernelChannel ch = c.connect(kernelId, Duration.ofSeconds(120))) {
                checkKernelPython(ch, r.endpointId());
                String root = c.endpoint().contentsRootInKernel();
                if (root != null) {
                    // 作業フォルダへ移る（本体の固定コード。データには触れない・同意画面のコードには含めない）
                    ExecutionResult cd = ch.execute(chdirCode(root + runDir), null).get(60, TimeUnit.SECONDS);
                    if (!cd.ok()) {
                        throw new IllegalStateException("cannot enter the job folder: " + cd.errorValue());
                    }
                }
                recordEnvironment(ch, cj);
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
            Path zip = collectOutputs(c, runDir + "/outputs", files, ledger.jobDir(cj).resolve("outputs.zip"));
            result.put("files", files);
            if (zip != null) {
                result.put(PluginArtifacts.ARTIFACT_KEY, zip.toString());
                result.put(PluginArtifacts.ARTIFACT_NAME_KEY, "outputs.zip");
                result.put(PluginArtifacts.TRUST_KEY, jobs.artifacts().trustNonce());
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
                ledger.remoteCleanup(cj, "ok");
            } catch (RuntimeException e) {
                log.warn("[compute] cannot delete remote folder {}: {}", runDir, e.getMessage());
                outcome = outcome + "+remote-cleanup-failed";
                ledger.remoteCleanup(cj, "failed");
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

    /** 作業フォルダへ移る固定コード。パスは本体が作った（英数字とハイフンと /）ものだけ。 */
    static String chdirCode(String absDir) {
        if (!absDir.matches("[A-Za-z0-9/_-]+")) {
            throw new IllegalArgumentException("unexpected job folder: " + absDir);
        }
        return "import os as _graphy_os\n_graphy_os.chdir('" + absDir + "')\ndel _graphy_os";
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
     * @param zip 書き出す先（台帳のジョブのフォルダ。H53 はここを指す）
     * @return zip のパス。outputs が空なら null
     */
    private Path collectOutputs(JupyterServerClient c, String dir, List<Map<String, Object>> files, Path zip)
            throws IOException {
        List<String> names = new ArrayList<>();
        listFiles(c, dir, "", names);
        if (names.isEmpty()) {
            return null;
        }
        if (names.size() > MAX_OUTPUT_FILES) {
            throw new IllegalStateException("too many output files: " + names.size());
        }
        Files.createDirectories(zip.getParent());
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

    /**
     * 計算機の環境（Python・PyTorch・CUDA・GPU 名）を台帳へ。{@link ComputeConnectionTester#PROBE} と同じ固定コードで、
     * データには触れない・同意画面のコードには含めない（作業フォルダへ移るコードと同じ扱い）。取れなくてもジョブは続ける。
     */
    private void recordEnvironment(KernelChannel ch, String cj) {
        try {
            ExecutionResult pr = ch.execute(ComputeConnectionTester.PROBE, null).get(60, TimeUnit.SECONDS);
            if (!pr.ok()) {
                return;
            }
            for (String line : pr.stdout().split("\n")) {
                int i = line.indexOf(ComputeConnectionTester.MARK);
                if (i < 0) {
                    continue;
                }
                JsonNode p = mapper.readTree(line.substring(i + ComputeConnectionTester.MARK.length()));
                ObjectNode env = mapper.createObjectNode();
                env.put("python", p.path("python").asText(null));
                JsonNode torch = p.path("torch");
                env.put("torch", torch.path("version").asText(null));
                env.put("cuda", torch.path("cudaVersion").asText(null));
                var gpus = env.putArray("gpu");
                for (JsonNode g : p.path("gpus")) {
                    gpus.add(g.path("name").asText(""));
                }
                ledger.env(cj, mapper.writeValueAsString(env));
                return;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            log.debug("[compute] cannot record the environment: {}", e.toString());
        }
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

    /**
     * 「この PC」では、カーネルの Python が main の選んだ Python と同じかを確かめる（kernelspec の取り違えで
     * 別の Python——torch が CPU 版など——で走るのを防ぐ）。違えば推測で通さず止める。
     */
    private void checkKernelPython(KernelChannel ch, String endpointId) throws Exception {
        String expected = endpoints.get(endpointId).map(ComputeEndpointRegistry.Entry::expectedExecutable).orElse(null);
        if (expected == null) {
            return;
        }
        ExecutionResult er = ch.execute("import sys; print(sys.executable)", null).get(60, TimeUnit.SECONDS);
        String actual = er.ok() ? er.stdout().strip() : "";
        if (!samePython(expected, actual)) {
            throw new IllegalStateException("kernel-python-mismatch: expected=" + expected + " actual=" + actual);
        }
    }

    static boolean samePython(String expected, String actual) {
        if (expected == null || actual == null || actual.isBlank()) {
            return false;
        }
        try {
            return Path.of(expected).toRealPath().equals(Path.of(actual).toRealPath());
        } catch (java.io.IOException | RuntimeException e) {
            return expected.equals(actual);
        }
    }

    private static String hostOf(String url) {
        try {
            return java.net.URI.create(url).getAuthority();
        } catch (RuntimeException e) {
            return "?";
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
