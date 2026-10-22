/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * シリーズ探索（検証）とフォルダコピーをジョブとして回し、進捗の問い合わせと中止ができるようにする
 * （{@code ExportJobService} と同じ形）。並行して回すのは 1 ジョブだけ。
 */
@Service
public class SeriesExtractJobService {

    private static final Logger log = LoggerFactory.getLogger(SeriesExtractJobService.class);

    private static final long FINISHED_TTL_MS = 60 * 60 * 1000L;

    public enum State { QUEUED, RUNNING, DONE, FAILED, CANCELLED }

    public enum Kind { VERIFY, COPY }

    /**
     * @param total  進捗の分母（数え終わるまで −1）。
     * @param verify DONE のとき。VERIFY は一致一覧、COPY は同じ一覧。
     * @param copy   COPY が DONE のとき。
     */
    public record Status(String jobId, Kind kind, State state, long total, long processed,
                         SeriesExtractService.VerifyResult verify, SeriesExtractService.CopyResult copy,
                         String error) {
    }

    private static final class Job implements SeriesExtractService.Progress {
        final String id = UUID.randomUUID().toString();
        final Kind kind;
        volatile State state = State.QUEUED;
        volatile long total = -1;
        volatile long processed;
        volatile boolean cancelRequested;
        volatile SeriesExtractService.VerifyResult verify;
        volatile SeriesExtractService.CopyResult copy;
        volatile String error;
        volatile long finishedAt;

        Job(Kind kind) {
            this.kind = kind;
        }

        @Override
        public void total(int n) {
            this.total = n;
        }

        @Override
        public void advance(int p) {
            this.processed = p;
        }

        @Override
        public boolean cancelled() {
            return cancelRequested;
        }

        Status toStatus() {
            return new Status(id, kind, state, total, processed, verify, copy, error);
        }
    }

    private final SeriesExtractService service;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "series-extract");
        t.setDaemon(true);
        return t;
    });

    public SeriesExtractJobService(SeriesExtractService service) {
        this.service = service;
    }

    public Status submitVerify(List<String> studyUids, List<SearchCondition> conditions, List<String> planes) {
        Job job = new Job(Kind.VERIFY);
        return enqueue(job, () -> job.verify = service.verify(studyUids, conditions, planes, job));
    }

    public Status submitCopy(List<String> studyUids, List<SearchCondition> conditions, List<String> planes,
                             String destination, boolean sequentialRename) {
        Job job = new Job(Kind.COPY);
        return enqueue(job, () -> {
            SeriesExtractService.CopyResult r = service.copyToFolder(
                    studyUids, conditions, planes, destination, sequentialRename, job);
            job.copy = r;
        });
    }

    private interface Body {
        void run() throws Exception;
    }

    private Status enqueue(Job job, Body body) {
        purgeOldJobs();
        jobs.put(job.id, job);
        worker.submit(() -> {
            try {
                if (job.cancelRequested) {
                    job.state = State.CANCELLED;
                    return;
                }
                job.state = State.RUNNING;
                body.run();
                job.state = State.DONE;
            } catch (SeriesExtractService.CancelledException e) {
                job.state = State.CANCELLED;
            } catch (Exception e) {
                log.warn("[series-extract] job {} failed", job.id, e);
                job.error = e.getMessage() != null ? e.getMessage() : e.toString();
                job.state = State.FAILED;
            } finally {
                job.finishedAt = System.currentTimeMillis();
            }
        });
        return job.toStatus();
    }

    public Status get(String jobId) {
        Job job = jobs.get(jobId);
        return job == null ? null : job.toStatus();
    }

    /** 中止を求める（冪等）。コピー済みの分は戻さない（取り込みの中止と同じ方針）。 */
    public Status cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) {
            return null;
        }
        job.cancelRequested = true;
        return job.toStatus();
    }

    private void purgeOldJobs() {
        long now = System.currentTimeMillis();
        for (Job j : jobs.values()) {
            if (j.finishedAt > 0 && now - j.finishedAt > FINISHED_TTL_MS) {
                jobs.remove(j.id);
            }
        }
    }
}
