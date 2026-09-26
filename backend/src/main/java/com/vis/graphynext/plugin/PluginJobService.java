/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import jakarta.annotation.PreDestroy;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;
import java.util.function.BooleanSupplier;

/**
 * プラグインのバックエンド面を<b>ジョブとして</b>走らせる（host API の H45 {@code runBackendJob}）。
 *
 * <h3>なぜ要るのか</h3>
 * {@code POST /api/plugins/{id}/run} は同期の 1 往復で、進み具合も取り消しも無い。
 * 動画の採点のように数十秒〜分かかる処理では、画面が固まったように見え、HTTP もタイムアウトしうる。
 * ここでは<b>投入してポーリングする</b>（{@code TextureJobService} と同じ形）。
 *
 * <h3>SPI は変えない</h3>
 * {@code GraphyPlugin.run(Map)} のまま、args に <b>JDK の関数型</b>を 2 つ入れて渡す
 * （SPI を JDK 標準型だけに保つ方針。プラグイン JAR が本体の型に依存しない）:
 * <ul>
 *   <li>{@value #PROGRESS_KEY} … {@code BiConsumer<Double, String>}（進み具合 0〜1 と、短い説明）</li>
 *   <li>{@value #CANCELLED_KEY} … {@code BooleanSupplier}（取り消されたら true。プラグインが区切りで見る）</li>
 * </ul>
 * 同期の {@code run} で呼ばれたときはどちらも入らないので、プラグインは「無ければ何もしない」で書くこと。
 * 要求本文に同名のキーがあっても<b>ここで上書きする</b>（JSON から関数は作れないが、文字列で
 * 塞がれてプラグインが型エラーで落ちるのを防ぐ）。
 */
@Service
public class PluginJobService {

    private static final Logger log = LoggerFactory.getLogger(PluginJobService.class);

    /** 進み具合の通知（{@code BiConsumer<Double, String>}）を入れる args のキー。 */
    public static final String PROGRESS_KEY = "__progress";
    /** 取り消しの問い合わせ（{@code BooleanSupplier}）を入れる args のキー。 */
    public static final String CANCELLED_KEY = "__cancelled";

    /** 同時に走らせるジョブの数。動画の読み出しのように I/O と CPU を両方使うので 2 本に抑える。 */
    private static final int WORKERS = 2;
    /** 終わったジョブを覚えておく上限と時間（結果を取りに来る前に消さないため）。 */
    private static final int MAX_FINISHED_JOBS = 50;
    private static final long FINISHED_TTL_MS = 60 * 60 * 1000L;

    public enum State { QUEUED, RUNNING, DONE, FAILED, CANCELLED }

    /** ジョブの外向きの姿。 */
    public record Status(
            String jobId,
            String pluginId,
            State state,
            double progress,
            String message,
            long elapsedMs,
            Object result,
            String error) {

        /** 終わったか（DONE / FAILED / CANCELLED）。 */
        public boolean ended() {
            return state == State.DONE || state == State.FAILED || state == State.CANCELLED;
        }
    }

    private static final class Job {
        final String id;
        final String pluginId;
        volatile State state = State.QUEUED;
        volatile double progress;
        volatile String message = "";
        volatile long startedAt;
        volatile long finishedAt;
        volatile Object result;
        volatile String error;
        final AtomicBoolean cancelled = new AtomicBoolean();

        Job(String id, String pluginId) {
            this.id = id;
            this.pluginId = pluginId;
        }

        long elapsedMs() {
            if (startedAt == 0) return 0;
            return (finishedAt > 0 ? finishedAt : System.currentTimeMillis()) - startedAt;
        }

        Status status() {
            return new Status(id, pluginId, state, progress, message, elapsedMs(), result, error);
        }
    }

    private final PluginRegistry registry;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService pool;

    public PluginJobService(PluginRegistry registry) {
        this.registry = registry;
        AtomicInteger seq = new AtomicInteger();
        this.pool = Executors.newFixedThreadPool(WORKERS, r -> {
            Thread t = new Thread(r, "plugin-job-" + seq.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
    }

    @PreDestroy
    void shutdown() {
        pool.shutdownNow();
    }

    /**
     * ジョブを投入する。
     *
     * @throws java.util.NoSuchElementException プラグインが存在しない
     * @throws UnsupportedOperationException このモード/プラグインでは実行できない（投入の時点で弾く）
     */
    public Status submit(String pluginId, Map<String, Object> payload) {
        registry.checkRunnable(pluginId);
        Map<String, Object> args = new HashMap<>(payload == null ? Map.of() : payload);
        return submitTask(pluginId, ctx -> {
            args.put(PROGRESS_KEY, ctx.progress());
            args.put(CANCELLED_KEY, ctx.cancelled());
            return registry.run(pluginId, args);
        });
    }

    /** ジョブの中から見える進み具合の口と取り消しの問い合わせ。 */
    public record TaskContext(BiConsumer<Double, String> progress, BooleanSupplier cancelled) {
    }

    /** ジョブとして走らせる処理。 */
    @FunctionalInterface
    public interface Task {
        Object run(TaskContext ctx) throws Exception;
    }

    /**
     * <b>本体の処理</b>をプラグインのジョブとして走らせる（プラグインのために本体が行う重い処理。
     * 例: H48 の動画の取り込み）。状態・取り消しの口はプラグインの JAR と同じ
     * （{@code /api/plugin-jobs/{jobId}}）ので、画面側は 1 つの待ち方で済む。
     *
     * @param pluginId 依頼したプラグイン（状態に出すだけ。存在の確認は呼び出し側が行う）
     */
    public Status submitTask(String pluginId, Task task) {
        sweep();
        Job job = new Job(UUID.randomUUID().toString(), pluginId);
        jobs.put(job.id, job);
        BiConsumer<Double, String> progress = (p, msg) -> {
            if (p != null && Double.isFinite(p)) job.progress = Math.max(0, Math.min(1, p));
            if (msg != null) job.message = msg;
        };
        TaskContext ctx = new TaskContext(progress, job.cancelled::get);
        pool.submit(() -> execute(job, task, ctx));
        return job.status();
    }

    private void execute(Job job, Task task, TaskContext ctx) {
        if (job.cancelled.get()) {
            finish(job, State.CANCELLED, null, null);
            return;
        }
        job.state = State.RUNNING;
        job.startedAt = System.currentTimeMillis();
        try {
            Object result = task.run(ctx);
            // 取り消しを受けたプラグインが途中の結果を返しても、「取り消し」として見せる
            finish(job, job.cancelled.get() ? State.CANCELLED : State.DONE, result, null);
        } catch (Exception e) {
            if (job.cancelled.get()) {
                finish(job, State.CANCELLED, null, null);
            } else {
                Throwable root = e.getCause() != null ? e.getCause() : e;
                log.warn("[plugins] job {} of {} failed: {}", job.id, job.pluginId, root.toString());
                finish(job, State.FAILED, null, String.valueOf(root.getMessage() != null ? root.getMessage() : root));
            }
        }
    }

    private static void finish(Job job, State state, Object result, String error) {
        job.result = result;
        job.error = error;
        if (state == State.DONE) job.progress = 1;
        job.finishedAt = System.currentTimeMillis();
        job.state = state;
    }

    public Optional<Status> status(String jobId) {
        return Optional.ofNullable(jobs.get(jobId)).map(Job::status);
    }

    /** 取り消しを求める。プラグインが {@value #CANCELLED_KEY} を見て止まるまで RUNNING のまま。 */
    public Optional<Status> cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) return Optional.empty();
        job.cancelled.set(true);
        return Optional.of(job.status());
    }

    /** 終わってから時間が経った / 数が多すぎるジョブを捨てる。 */
    private void sweep() {
        long now = System.currentTimeMillis();
        jobs.values().removeIf(j -> j.finishedAt > 0 && now - j.finishedAt > FINISHED_TTL_MS);
        List<Job> finished = new ArrayList<>(jobs.values().stream().filter(j -> j.finishedAt > 0).toList());
        if (finished.size() > MAX_FINISHED_JOBS) {
            finished.sort(Comparator.comparingLong(j -> j.finishedAt));
            for (int i = 0; i < finished.size() - MAX_FINISHED_JOBS; i++) jobs.remove(finished.get(i).id);
        }
    }
}
