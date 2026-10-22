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
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * フィルタ画像（派生シリーズ）の作成のジョブ管理（投入してポーリングする）。ワーカーは 1 本。
 * 取り消しは「今のスケールを書き終えて、残りは始めない」（作り終えたシリーズは保管庫に残る）。
 */
@Service
public class FilteredSeriesJobService {

    private static final Logger log = LoggerFactory.getLogger(FilteredSeriesJobService.class);

    private static final int MAX_FINISHED_JOBS = 50;
    private static final long FINISHED_TTL_MS = 60 * 60 * 1000L;

    public enum State { QUEUED, RUNNING, DONE, FAILED, CANCELLED }

    /**
     * scaleDone は作り終えた数、scaleTotal は全数、scaleMm は今の半径 r。取り消したとき、作り終えたぶんは
     * {@code created} に残る（保管庫にあるシリーズを利用者が知れるように）。
     */
    public record Status(String jobId, State state, long elapsedMs, FilteredSeriesService.Result result, String error,
                         int scaleDone, int scaleTotal, double scaleMm, List<FilteredSeriesService.Created> created) {}

    private static final class Job {
        final String id;
        volatile State state = State.QUEUED;
        volatile boolean cancelled;
        volatile long startedAt;
        volatile long finishedAt;
        volatile FilteredSeriesService.Result result;
        volatile String error;
        volatile int scaleDone;
        volatile int scaleTotal;
        volatile double scaleMm;
        /** 作り終えたシリーズ（取り消し・失敗のときも、保管庫に入ったものを知らせる）。 */
        final List<FilteredSeriesService.Created> created = new java.util.concurrent.CopyOnWriteArrayList<>();

        Job(String id) {
            this.id = id;
        }

        long elapsedMs() {
            if (startedAt == 0) return 0;
            return (finishedAt > 0 ? finishedAt : System.currentTimeMillis()) - startedAt;
        }

        Status toStatus() {
            State s = cancelled ? State.CANCELLED : state;
            return new Status(id, s, elapsedMs(), cancelled ? null : result, error, scaleDone, scaleTotal, scaleMm,
                    List.copyOf(created));
        }
    }

    private final FilteredSeriesService service;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "filtered-series");
        t.setDaemon(true);
        return t;
    });

    public FilteredSeriesJobService(FilteredSeriesService service) {
        this.service = service;
    }

    /** 検査を通してから投入する。web モード・必須項目・不正なスケールはここで例外になる。 */
    public Status submit(FilteredSeriesRequest req) {
        service.check(req);
        purgeOldJobs();
        Job job = new Job(UUID.randomUUID().toString());
        jobs.put(job.id, job);
        log.info("[filtered-series] job {} queued: series={}", job.id, req.sourceSeriesUid());
        worker.submit(() -> run(job, req));
        return job.toStatus();
    }

    public Status get(String jobId) {
        Job job = jobs.get(jobId);
        return job != null ? job.toStatus() : null;
    }

    public Status cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) {
            return null;
        }
        job.cancelled = true;
        log.info("[filtered-series] job {} cancelled (state={})", jobId, job.state);
        return job.toStatus();
    }

    private void run(Job job, FilteredSeriesRequest req) {
        job.startedAt = System.currentTimeMillis();
        job.state = State.RUNNING;
        try {
            job.result = service.create(req, (done, total, rMm) -> {
                job.scaleDone = done;
                job.scaleTotal = total;
                job.scaleMm = rMm;
            }, () -> job.cancelled, job.created::add);
            job.state = State.DONE;
            log.info("[filtered-series] job {} done in {} ms ({} series)", job.id, job.elapsedMs(),
                    job.result.series().size());
        } catch (CancellationException e) {
            log.info("[filtered-series] job {} stopped at a scale boundary", job.id);
        } catch (IllegalArgumentException | IllegalStateException e) {
            job.state = State.FAILED;
            job.error = e.getMessage();
            log.warn("[filtered-series] job {} rejected: {}", job.id, e.getMessage());
        } catch (Exception e) {
            job.state = State.FAILED;
            job.error = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            log.error("[filtered-series] job {} failed", job.id, e);
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
