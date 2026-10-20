/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.compute.ComputeJobStateMachine.Reason;
import com.vis.graphynext.compute.ComputeJobStateMachine.State;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * 計算ジョブの台帳（H2）と、ログ・結果のファイル（{@code <jobs-dir>/<jobId>/}）の窓口。
 * 状態の書き換えはすべてここを通り、{@link ComputeJobStateMachine} の表に無い遷移は通さない。
 *
 * <p>🔴 持たないもの: 患者名・患者 ID・検査記述（{@link ComputeBatchRecord}）。持つ元の UID は保管庫と同じ PC の中だけ。
 * 書き換えは {@code synchronized} で直列にする（待ちの中止と実行の開始が同時に来ても、どちらか一方だけが通る）。
 */
@Service
public class ComputeJobLedger {

    private static final Logger log = LoggerFactory.getLogger(ComputeJobLedger.class);
    /** 進み具合を台帳へ書く間隔の下限（段が変わるとき・最後は必ず書く）。 */
    private static final long PROGRESS_WRITE_MS = 1000;
    private static final double PROGRESS_WRITE_STEP = 0.05;

    /** 画面・再実行に出すプラグインの素性。同梱・開発配置の SHA-256 は台帳に無いので null＝不明。 */
    public record PluginFacts(String name, String version, String packageSha256) {
    }

    /** プラグイン id → 素性（本番は {@link ComputePluginFacts}、テストはラムダ）。 */
    @FunctionalInterface
    interface PluginFactsResolver {
        PluginFacts of(String pluginId);
    }

    /** 入力の 1 件。 */
    record InputRef(String studyUid, String seriesUid, String format) {
    }

    private record Written(String phase, double progress, long at) {
    }

    private final ComputeJobStore store;
    private final ObjectMapper mapper;
    private final Path jobsRoot;
    private final Clock clock;
    private final PluginFactsResolver facts;
    private final Map<String, Written> lastWritten = new HashMap<>();

    @Autowired
    ComputeJobLedger(ComputeJobStore store, ObjectMapper mapper,
                     @Value("${graphy.compute.jobs-dir:compute-jobs}") String jobsDir, PluginFactsResolver facts) {
        this(store, mapper, Path.of(jobsDir).toAbsolutePath().normalize(), Clock.systemUTC(), facts);
    }

    ComputeJobLedger(ComputeJobStore store, ObjectMapper mapper, Path jobsRoot, Clock clock,
                     PluginFactsResolver facts) {
        this.store = store;
        this.mapper = mapper;
        this.jobsRoot = jobsRoot;
        this.clock = clock;
        this.facts = facts;
    }

    Path jobsRoot() {
        return jobsRoot;
    }

    /** ジョブのフォルダ（ログ・結果の置き場）。id は本体が作った {@code cj_<uuid>} だけ。 */
    Path jobDir(String jobId) {
        if (!jobId.matches("cj_[0-9a-f-]{36}")) {
            throw new IllegalArgumentException("bad job id");
        }
        return jobsRoot.resolve(jobId);
    }

    // ── 作る ──

    /** 承認済みの要求から、待ちの 1 件（と 1 バッチ）を作る。 */
    synchronized String create(ComputeEgressService.EgressRequest r, List<InputRef> inputs, int timeoutSec) {
        Instant now = clock.instant();
        PluginFacts pf = facts.of(r.pluginId());
        ComputeBatchRecord b = new ComputeBatchRecord("cb_" + UUID.randomUUID());
        b.pluginId = r.pluginId();
        b.pluginName = r.pluginName() != null ? r.pluginName() : pf.name();
        b.pluginVersion = pf.version();
        b.pluginPackageSha256 = pf.packageSha256();
        b.code = r.code();
        b.codeSha256 = r.codeSha256();
        b.endpointId = r.endpointId();
        b.endpointLabel = r.endpointLabel();
        b.endpointKind = r.endpointKind();
        b.endpointHost = hostOf(r.endpointUrl());
        b.plaintext = r.plaintext();
        b.timeoutSec = timeoutSec;
        b.interactive = true;
        b.consentRequestId = r.id();
        b.createdAt = now;
        store.saveBatch(b);

        ComputeJobRecord j = new ComputeJobRecord("cj_" + UUID.randomUUID(), b.id);
        j.inputRefs = json(inputs);
        j.requestId = r.id();
        j.contentHash = r.contentHash();
        j.state = State.QUEUED.name();
        j.queuedAt = now;
        store.saveJob(j);
        return j.id;
    }

    synchronized void attachPluginJob(String jobId, String pluginJobId) {
        update(jobId, j -> j.pluginJobId = pluginJobId);
    }

    // ── 遷移 ──

    /** 順番が来た。待ちのままのときだけ RUNNING にする（待ちの間に中止されていれば false）。 */
    synchronized boolean start(String jobId, String remoteRunDir) {
        ComputeJobRecord j = job(jobId);
        if (State.valueOf(j.state) != State.QUEUED) {
            return false;
        }
        j.state = ComputeJobStateMachine.move(State.QUEUED, State.RUNNING).name();
        j.startedAt = clock.instant();
        j.remoteRunDir = remoteRunDir;
        store.saveJob(j);
        return true;
    }

    /** 待ちのままなら中止にする（アップロードは 1 回も起きない）。済んでいれば false。 */
    synchronized boolean cancelIfQueued(String jobId) {
        ComputeJobRecord j = job(jobId);
        if (State.valueOf(j.state) != State.QUEUED) {
            return false;
        }
        j.state = ComputeJobStateMachine.move(State.QUEUED, State.CANCELLED).name();
        j.finishedAt = clock.instant();
        store.saveJob(j);
        return true;
    }

    /** 段・進み具合。書きすぎないよう、段が変わるか一定以上進んだときだけ書く。 */
    synchronized void progress(String jobId, String phase, double progress, String message) {
        Written w = lastWritten.get(jobId);
        long now = clock.millis();
        boolean write = w == null || !w.phase().equals(phase) || Math.abs(progress - w.progress()) >= PROGRESS_WRITE_STEP
                || now - w.at() >= PROGRESS_WRITE_MS;
        if (!write) {
            return;
        }
        lastWritten.put(jobId, new Written(phase, progress, now));
        update(jobId, j -> {
            j.phase = phase;
            j.progress = progress;
            j.message = cut(message, 400);
        });
    }

    synchronized void remoteRunDir(String jobId, String dir) {
        update(jobId, j -> j.remoteRunDir = dir);
    }

    synchronized void kernelId(String jobId, String kernelId) {
        update(jobId, j -> j.kernelId = kernelId);
    }

    synchronized void env(String jobId, String envJson) {
        update(jobId, j -> j.envJson = envJson);
    }

    synchronized void remoteCleanup(String jobId, String status) {
        update(jobId, j -> j.remoteCleanup = status);
    }

    /** 終わった。{@code reason} は FAILED / INTERRUPTED のとき。 */
    synchronized void finish(String jobId, State to, Reason reason, String errorName, String errorValue,
                             long outputsBytes) {
        lastWritten.remove(jobId);
        ComputeJobRecord j = job(jobId);
        j.state = ComputeJobStateMachine.move(State.valueOf(j.state), to).name();
        j.finishedAt = clock.instant();
        j.reason = reason == null ? null : reason.code;
        j.errorName = cut(errorName, 200);
        j.errorValue = cut(errorValue, ComputeJobRecord.ERROR_VALUE_MAX);
        j.outputsBytes = outputsBytes;
        if (to == State.DONE) {
            j.progress = 1;
        }
        store.saveJob(j);
    }

    // ── 読む ──

    Optional<ComputeJobRecord> find(String jobId) {
        return store.findJob(jobId);
    }

    Optional<ComputeBatchRecord> batchOf(ComputeJobRecord j) {
        return store.findBatch(j.batchId);
    }

    List<ComputeJobRecord> list() {
        return store.listJobs();
    }

    List<InputRef> inputsOf(ComputeJobRecord j) {
        try {
            return j.inputRefs == null ? List.of() : mapper.readValue(j.inputRefs, new TypeReference<>() {
            });
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ── ログ・結果のファイル ──

    /** stdout / stderr / traceback をジョブのフォルダへ。空なら作らない。 */
    void writeLogs(String jobId, String stdout, String stderr, String traceback) {
        try {
            Path dir = jobDir(jobId);
            Files.createDirectories(dir);
            writeIfAny(dir.resolve("stdout.txt"), stdout);
            writeIfAny(dir.resolve("stderr.txt"), stderr);
            writeIfAny(dir.resolve("traceback.txt"), traceback);
        } catch (IOException e) {
            log.warn("[compute] cannot write job logs of {}: {}", jobId, e.toString());
        }
    }

    /** ログのファイルの中身。無ければ空。{@code kind} は stdout / stderr / traceback だけ。 */
    Optional<String> readLog(String jobId, String kind) {
        if (!List.of("stdout", "stderr", "traceback").contains(kind)) {
            return Optional.empty();
        }
        Path f = jobDir(jobId).resolve(kind + ".txt");
        try {
            return Optional.of(Files.isRegularFile(f) ? Files.readString(f, StandardCharsets.UTF_8) : "");
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    // ── 消す ──

    /** 終わった行とそのフォルダを消す。まだ終わっていなければ例外。 */
    synchronized void delete(String jobId) {
        ComputeJobRecord j = job(jobId);
        if (!State.valueOf(j.state).ended()) {
            throw new IllegalStateException("job is not finished: " + j.state);
        }
        store.deleteJob(jobId);
        if (store.countJobsInBatch(j.batchId) == 0) {
            store.deleteBatch(j.batchId);
        }
        lastWritten.remove(jobId);
        deleteTree(jobDir(jobId));
    }

    /**
     * 保管庫から消えたシリーズの UID を台帳から空にする（行は「削除済み・再実行不可」になる）。
     * シリーズの UID は検査の UID と対で消す。
     */
    public synchronized int clearSeries(Collection<String> seriesUids) {
        int changed = 0;
        for (String uid : seriesUids) {
            if (uid == null || uid.isBlank()) {
                continue;
            }
            for (ComputeJobRecord j : store.findJobsReferencing(uid)) {
                List<InputRef> now = new ArrayList<>();
                boolean hit = false;
                for (InputRef in : inputsOf(j)) {
                    if (uid.equals(in.seriesUid())) {
                        now.add(new InputRef("", "", in.format()));
                        hit = true;
                    } else {
                        now.add(in);
                    }
                }
                if (hit) {
                    j.inputRefs = json(now);
                    store.saveJob(j);
                    changed++;
                }
            }
        }
        return changed;
    }

    // ── 起動時の回復 ──

    /**
     * 起動時: 待ち・実行中・利用者待ちのまま残った行を「再起動で中断」にする。
     * 作業フォルダを持っていた行は、計算機側の後始末が済んでいないので {@code remote_cleanup = pending} にする。
     *
     * @return 中断にした件数
     */
    synchronized int recoverInterrupted() {
        int n = 0;
        for (ComputeJobRecord j : store.findJobsByState(
                EnumSet.of(State.QUEUED, State.RUNNING, State.AWAITING_USER).stream().map(Enum::name).toList())) {
            j.state = ComputeJobStateMachine.move(State.valueOf(j.state), State.INTERRUPTED).name();
            j.reason = Reason.INTERRUPTED.code;
            j.finishedAt = clock.instant();
            if (j.remoteRunDir != null && j.remoteCleanup == null) {
                j.remoteCleanup = "pending";
            }
            store.saveJob(j);
            n++;
        }
        return n;
    }

    List<ComputeJobRecord> cleanupPending() {
        return store.findCleanupPending();
    }

    // ── 内部 ──

    private ComputeJobRecord job(String id) {
        return store.findJob(id).orElseThrow(() -> new IllegalStateException("unknown compute job: " + id));
    }

    private void update(String id, java.util.function.Consumer<ComputeJobRecord> f) {
        ComputeJobRecord j = job(id);
        f.accept(j);
        store.saveJob(j);
    }

    private String json(Object o) {
        try {
            return mapper.writeValueAsString(o);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static String cut(String s, int max) {
        return s == null ? null : s.length() <= max ? s : s.substring(0, max);
    }

    private static String hostOf(String url) {
        try {
            return URI.create(url).getAuthority();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static void writeIfAny(Path f, String text) throws IOException {
        if (text != null && !text.isEmpty()) {
            Files.writeString(f, text, StandardCharsets.UTF_8);
        }
    }

    static void deleteTree(Path d) {
        if (!Files.isDirectory(d)) {
            return;
        }
        try (Stream<Path> w = Files.walk(d)) {
            for (Path p : w.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        } catch (IOException e) {
            log.warn("[compute] cannot delete {}: {}", d, e.toString());
        }
    }

    /** 画面用の 1 行（台帳の列から、患者情報の無いものだけ）。 */
    Map<String, Object> view(ComputeJobRecord j) {
        Map<String, Object> m = new LinkedHashMap<>();
        ComputeBatchRecord b = store.findBatch(j.batchId).orElse(null);
        m.put("id", j.id);
        m.put("batchId", j.batchId);
        m.put("state", j.state);
        m.put("phase", j.phase);
        m.put("progress", j.progress);
        m.put("message", j.message);
        m.put("reason", j.reason);
        m.put("errorName", j.errorName);
        m.put("errorValue", j.errorValue);
        m.put("attempt", j.attempt);
        m.put("itemKey", j.itemKey);
        m.put("inputs", inputsOf(j).stream().map(i -> {
            Map<String, Object> im = new LinkedHashMap<>();
            im.put("studyUid", i.studyUid());
            im.put("seriesUid", i.seriesUid());
            im.put("format", i.format());
            im.put("deleted", i.seriesUid() == null || i.seriesUid().isEmpty());
            return im;
        }).toList());
        m.put("requestId", j.requestId);
        m.put("pluginJobId", j.pluginJobId);
        m.put("env", j.envJson == null ? null : readTree(j.envJson));
        m.put("remoteCleanup", j.remoteCleanup);
        m.put("queuedAt", j.queuedAt);
        m.put("startedAt", j.startedAt);
        m.put("finishedAt", j.finishedAt);
        m.put("outputsBytes", j.outputsBytes);
        m.put("collectedAt", j.collectedAt);
        if (b != null) {
            m.put("pluginId", b.pluginId);
            m.put("pluginName", b.pluginName);
            m.put("pluginVersion", b.pluginVersion);
            m.put("pluginPackageSha256", b.pluginPackageSha256);
            m.put("codeSha256", b.codeSha256);
            m.put("endpointId", b.endpointId);
            m.put("endpointLabel", b.endpointLabel);
            m.put("endpointKind", b.endpointKind);
            m.put("endpointHost", b.endpointHost);
            m.put("plaintext", b.plaintext);
            m.put("timeoutSec", b.timeoutSec);
        }
        return m;
    }

    private Object readTree(String s) {
        try {
            return mapper.readTree(s);
        } catch (IOException e) {
            return null;
        }
    }
}
