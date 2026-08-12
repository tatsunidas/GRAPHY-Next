/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Texture 可視化マップ計算のジョブ管理。
 *
 * <p>マップ計算は分単位になりうる（GLAM でカーネルを大きく取ると特に。
 * {@code fw/texture-radiomics-design.md} §11.6 の実測）。同期 POST では HTTP がタイムアウトし、
 * 進み具合も見えないため、<b>投入してポーリングする</b>形にする。
 *
 * <p><b>ワーカーは 1 本</b>。マップ計算は RadiomicsJ 側が既に全コアを使って並列化しているので、
 * ジョブを同時に走らせてもコアの取り合いになるだけで速くならない。加えて GLAM は
 * {@code RadiomicsJ} の static を書き換えるため、そもそも同時に走らせられない
 * （{@link GlamMapSupport#runWithSettings} が直列化する）。
 */
@Service
public class TextureJobService {

    private static final Logger log = LoggerFactory.getLogger(TextureJobService.class);

    /** 終わったジョブを覚えておく上限。これを超えたら古い順に捨てる。 */
    private static final int MAX_FINISHED_JOBS = 50;

    /** 終わったジョブを覚えておく時間。 */
    private static final long FINISHED_TTL_MS = 60 * 60 * 1000L;

    public enum State { QUEUED, RUNNING, DONE, FAILED, CANCELLED }

    /** ジョブの外向きの姿。 */
    public record Status(
            String jobId,
            State state,
            String feature,
            int slicesDone,
            int slicesTotal,
            long elapsedMs,
            TextureSeriesService.Result result,
            String error) {
    }

    /** ジョブの内部状態。 */
    private static final class Job {
        final String id;
        final String feature;
        final long submittedAt = System.currentTimeMillis();
        volatile State state = State.QUEUED;
        volatile int slicesDone;
        volatile int slicesTotal;
        volatile long startedAt;
        volatile long finishedAt;
        volatile TextureSeriesService.Result result;
        volatile String error;
        final AtomicBoolean cancelled = new AtomicBoolean();

        Job(String id, String feature) {
            this.id = id;
            this.feature = feature;
        }

        long elapsedMs() {
            if (startedAt == 0) return 0;
            return (finishedAt > 0 ? finishedAt : System.currentTimeMillis()) - startedAt;
        }

        Status toStatus() {
            return new Status(id, state, feature, slicesDone, slicesTotal, elapsedMs(), result, error);
        }
    }

    /** キャンセルされたジョブが計算を抜けるための合図。 */
    static final class CancelledException extends RuntimeException {
        CancelledException() {
            super("計算はキャンセルされました");
        }
    }

    private final TextureSeriesService service;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "texture-map");
        t.setDaemon(true);
        return t;
    });

    public TextureJobService(TextureSeriesService service) {
        this.service = service;
    }

    /** 計算を投入して、まだ何も起きていない状態を返す。 */
    public Status submit(TextureSeriesRequest req) {
        purgeOldJobs();
        String id = UUID.randomUUID().toString();
        Job job = new Job(id, req.feature());
        jobs.put(id, job);
        log.info("[texture] job {} queued: feature={} series={}", id, req.feature(), req.sourceSeriesUid());
        worker.submit(() -> run(job, req));
        return job.toStatus();
    }

    /** 現在の状態。知らない ID なら null。 */
    public Status get(String jobId) {
        Job job = jobs.get(jobId);
        return job != null ? job.toStatus() : null;
    }

    /**
     * キャンセルを頼む。実際に止まるのは次のスライスが終わったところなので、
     * すぐに {@code CANCELLED} になるとは限らない。
     */
    public Status cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) {
            return null;
        }
        if (job.state == State.QUEUED || job.state == State.RUNNING) {
            job.cancelled.set(true);
            log.info("[texture] job {} cancellation requested", jobId);
        }
        return job.toStatus();
    }

    private void run(Job job, TextureSeriesRequest req) {
        if (job.cancelled.get()) {
            job.state = State.CANCELLED;
            job.finishedAt = System.currentTimeMillis();
            return;
        }
        job.state = State.RUNNING;
        job.startedAt = System.currentTimeMillis();
        try {
            TextureProgress progress = (done, total) -> {
                if (job.cancelled.get()) {
                    throw new CancelledException();
                }
                job.slicesDone = done;
                job.slicesTotal = total;
            };
            job.result = service.create(req, progress);
            job.state = State.DONE;
            log.info("[texture] job {} done in {} ms -> series {}", job.id, job.elapsedMs(),
                    job.result.seriesInstanceUid());
        } catch (CancelledException e) {
            job.state = State.CANCELLED;
            log.info("[texture] job {} cancelled after {} ms", job.id, job.elapsedMs());
        } catch (IllegalArgumentException e) {
            // 要求そのものが通らない（GLAM を 2D で頼んだ等）。利用者に見せてよい文言。
            job.state = State.FAILED;
            job.error = e.getMessage();
            log.warn("[texture] job {} rejected: {}", job.id, e.getMessage());
        } catch (Exception e) {
            job.state = State.FAILED;
            job.error = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            log.error("[texture] job {} failed", job.id, e);
        } finally {
            job.finishedAt = System.currentTimeMillis();
        }
    }

    /** 終わったジョブを、古いものから上限まで削る。 */
    private void purgeOldJobs() {
        long now = System.currentTimeMillis();
        List<Job> finished = new ArrayList<>();
        for (Job job : jobs.values()) {
            if (job.state == State.QUEUED || job.state == State.RUNNING) {
                continue;
            }
            if (job.finishedAt > 0 && now - job.finishedAt > FINISHED_TTL_MS) {
                jobs.remove(job.id);
            } else {
                finished.add(job);
            }
        }
        if (finished.size() > MAX_FINISHED_JOBS) {
            finished.sort(Comparator.comparingLong(j -> j.finishedAt));
            for (int i = 0; i < finished.size() - MAX_FINISHED_JOBS; i++) {
                jobs.remove(finished.get(i).id);
            }
        }
    }
}
