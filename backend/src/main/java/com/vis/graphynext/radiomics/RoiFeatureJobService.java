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

/**
 * ROI 特徴量表の計算のジョブ管理（投入してポーリングする）。
 *
 * <p>RadiomicsJ の一括抽出には取り消しの口が無い。取り消しは<b>結果を見せないだけ</b>で、計算は最後まで
 * 走り、結果はキャッシュに入る（次の同じ要求で返る）。ワーカーは 1 本。マップのジョブとは
 * {@link RadiomicsLock} で直列化する。
 */
@Service
public class RoiFeatureJobService {

    private static final Logger log = LoggerFactory.getLogger(RoiFeatureJobService.class);

    private static final int MAX_FINISHED_JOBS = 50;
    private static final long FINISHED_TTL_MS = 60 * 60 * 1000L;

    public enum State { QUEUED, LOADING, EXTRACTING, DONE, FAILED, CANCELLED }

    public record Status(String jobId, State state, long elapsedMs, RoiFeatureResult result, String error) {}

    private static final class Job {
        final String id;
        volatile State state = State.QUEUED;
        volatile boolean cancelled;
        volatile long startedAt;
        volatile long finishedAt;
        volatile RoiFeatureResult result;
        volatile String error;

        Job(String id) {
            this.id = id;
        }

        long elapsedMs() {
            if (startedAt == 0) return 0;
            return (finishedAt > 0 ? finishedAt : System.currentTimeMillis()) - startedAt;
        }

        Status toStatus() {
            // 取り消した後に計算が終わっても、結果は見せない
            if (cancelled) {
                return new Status(id, State.CANCELLED, elapsedMs(), null, null);
            }
            return new Status(id, state, elapsedMs(), result, error);
        }
    }

    private final RoiFeatureService service;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "roi-features");
        t.setDaemon(true);
        return t;
    });

    public RoiFeatureJobService(RoiFeatureService service) {
        this.service = service;
    }

    /** 検査を通してから投入する。web モード・必須項目・設定キーの誤りはここで例外になる。 */
    public Status submit(RoiFeatureRequest req) {
        service.check(req);
        purgeOldJobs();
        Job job = new Job(UUID.randomUUID().toString());
        jobs.put(job.id, job);
        log.info("[roi-features] job {} queued: series={}", job.id, req.sourceSeriesUid());
        worker.submit(() -> run(job, req));
        return job.toStatus();
    }

    public Status get(String jobId) {
        Job job = jobs.get(jobId);
        return job != null ? job.toStatus() : null;
    }

    /** 取り消す。走り出した計算は止まらない（結果はキャッシュに入る）。 */
    public Status cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) {
            return null;
        }
        job.cancelled = true;
        log.info("[roi-features] job {} cancelled (state={})", jobId, job.state);
        return job.toStatus();
    }

    private void run(Job job, RoiFeatureRequest req) {
        job.startedAt = System.currentTimeMillis();
        try {
            job.result = service.compute(req, phase ->
                    job.state = phase == RoiFeatureService.Phase.LOADING ? State.LOADING : State.EXTRACTING);
            job.state = State.DONE;
            log.info("[roi-features] job {} done in {} ms (cache={})", job.id, job.elapsedMs(),
                    job.result.fromCache());
        } catch (IllegalArgumentException | IllegalStateException e) {
            job.state = State.FAILED;
            job.error = e.getMessage();
            log.warn("[roi-features] job {} rejected: {}", job.id, e.getMessage());
        } catch (Exception e) {
            job.state = State.FAILED;
            job.error = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            log.error("[roi-features] job {} failed", job.id, e);
        } finally {
            job.finishedAt = System.currentTimeMillis();
        }
    }

    private void purgeOldJobs() {
        long now = System.currentTimeMillis();
        List<Job> finished = new ArrayList<>();
        for (Job job : jobs.values()) {
            if (job.finishedAt == 0) {
                continue;
            }
            if (now - job.finishedAt > FINISHED_TTL_MS) {
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
