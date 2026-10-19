/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * フォルダ・ファイル・ZIP の取り込みをジョブとして回す（進捗の問い合わせと中止ができる）。
 * 投入 → {@code SCANNING}（総数を数える）→ {@code IMPORTING}（件数が進む）→ 終了。
 * 並行して回すのは 1 ジョブだけで、2 つ目以降は {@code QUEUED} で待つ（保管庫への書き込みを混ぜない）。
 *
 * <p>中止は「次の 1 件の前」で止まる。中止までに取り込んだ分は巻き戻さず、結果に数えて返す。
 * 流儀は {@link UrlImportService} と同じ（standalone だけ・終了後 1 時間で忘れる）。
 */
@Service
@Profile("standalone")
public class PathImportJobService {

    private static final Logger log = LoggerFactory.getLogger(PathImportJobService.class);

    private static final long FINISHED_TTL_MS = 60 * 60 * 1000L;

    public enum State { QUEUED, SCANNING, IMPORTING, DONE, FAILED, CANCELLED }

    /** @param total 総数。数え終わるまで（と数えられなかったとき）は −1。 */
    public record Status(String jobId, State state, long total, long processed, int imported, int skipped, int failed,
                         ImportService.ImportResult result, String error) {
    }

    private static final class Job {
        final String id = UUID.randomUUID().toString();
        final ImportService.Progress progress = new ImportService.Progress();
        volatile State state = State.QUEUED;
        volatile ImportService.ImportResult result;
        volatile String error;
        volatile long finishedAt;

        Status toStatus() {
            return new Status(id, state, progress.total(), progress.processed(), progress.imported(),
                    progress.skipped(), progress.failed(), result, error);
        }
    }

    private final ImportService importer;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "path-import");
        t.setDaemon(true);
        return t;
    });

    public PathImportJobService(ImportService importer) {
        this.importer = importer;
    }

    public Status submit(List<String> paths) {
        purgeOldJobs();
        Job job = new Job();
        jobs.put(job.id, job);
        List<String> copy = paths == null ? List.of() : List.copyOf(paths);
        worker.submit(() -> run(job, copy));
        return job.toStatus();
    }

    public Status get(String jobId) {
        Job job = jobs.get(jobId);
        return job == null ? null : job.toStatus();
    }

    /** 中止を求める（冪等）。終わったジョブには何も起きない。 */
    public Status cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) {
            return null;
        }
        job.progress.cancel();
        return job.toStatus();
    }

    private void run(Job job, List<String> paths) {
        try {
            if (!job.progress.isCancelled()) {
                job.state = State.SCANNING;
                job.progress.setTotal(importer.countFiles(paths, job.progress));
                job.state = State.IMPORTING;
            }
            job.result = importer.importPaths(paths, job.progress);
            job.state = job.progress.isCancelled() ? State.CANCELLED : State.DONE;
        } catch (Exception e) {
            log.warn("[path-import] job {} failed", job.id, e);
            job.error = e.getMessage() != null ? e.getMessage() : e.toString();
            job.state = State.FAILED;
        } finally {
            job.finishedAt = System.currentTimeMillis();
        }
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
