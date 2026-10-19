/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Stream;
import java.util.zip.ZipOutputStream;

/**
 * エクスポートをジョブとして回す（進捗の問い合わせと中止ができる）。出力はサーバー（=この PC）のフォルダなので
 * standalone だけ。ZIP オフなら {@code <出力先>/<名前>/}、オンなら {@code <出力先>/<名前>.zip} を作る
 * （ZIP は直接書くので、フォルダを作ってから固める二重のディスク使用はしない）。
 *
 * <p>中止・失敗のときは<b>書きかけの出力を消す</b>（半端な媒体を残さない）。並行して回すのは 1 ジョブだけ。
 */
@Service
@Profile("standalone")
public class ExportJobService {

    private static final Logger log = LoggerFactory.getLogger(ExportJobService.class);

    private static final long FINISHED_TTL_MS = 60 * 60 * 1000L;
    /** 見積りに足す余白（DICOMDIR・VIEWER・README・動画 MP4 など）。 */
    static final long RESERVE_BYTES = 1L << 30;

    public enum State { QUEUED, RUNNING, DONE, FAILED, CANCELLED }

    /** @param total 総数（数え終わるまで −1）。@param outputPath 完了したときの出力（フォルダまたは ZIP）。 */
    public record Status(String jobId, State state, long total, long processed, String outputPath, String error) {
    }

    private static final class Job {
        final String id = UUID.randomUUID().toString();
        final ExportService.Progress progress = new ExportService.Progress();
        volatile State state = State.QUEUED;
        volatile String outputPath;
        volatile String error;
        volatile long finishedAt;

        Status toStatus() {
            return new Status(id, state, progress.total(), progress.processed(), outputPath, error);
        }
    }

    private final ExportService export;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "export");
        t.setDaemon(true);
        return t;
    });

    public ExportJobService(ExportService export) {
        this.export = export;
    }

    /** @throws IllegalArgumentException 出力先が既存のフォルダでないとき（呼び出し側は 400 にする） */
    public Status submit(List<ExportService.Selection> selections, boolean withViewer, boolean zip, String destination) {
        Path dest;
        try {
            dest = destination == null || destination.isBlank() ? null : Paths.get(destination).toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("出力先が不正です");
        }
        if (dest == null || !Files.isDirectory(dest)) {
            throw new IllegalArgumentException("出力先のフォルダが見つかりません");
        }
        purgeOldJobs();
        Job job = new Job();
        jobs.put(job.id, job);
        List<ExportService.Selection> copy = List.copyOf(selections);
        worker.submit(() -> run(job, copy, withViewer, zip, dest));
        return job.toStatus();
    }

    public Status get(String jobId) {
        Job job = jobs.get(jobId);
        return job == null ? null : job.toStatus();
    }

    /** 中止を求める（冪等）。 */
    public Status cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) {
            return null;
        }
        job.progress.cancel();
        return job.toStatus();
    }

    private void run(Job job, List<ExportService.Selection> selections, boolean withViewer, boolean zip, Path dest) {
        Path out = null;
        try {
            if (job.progress.isCancelled()) {
                job.state = State.CANCELLED;
                return;
            }
            job.state = State.RUNNING;
            job.progress.setTotal(export.countInstances(selections));
            long need = export.estimateBytes(selections) + RESERVE_BYTES;
            long free = Files.getFileStore(dest).getUsableSpace();
            if (free < need) {
                throw new IOException("出力先の空き容量が足りません（必要の目安 " + (need >> 20) + " MiB、空き " + (free >> 20) + " MiB）");
            }
            String name = ExportController.outputName(export.patientIds(selections));
            out = uniqueIn(dest, name, zip ? ".zip" : "");
            ExportService.Options opts = ExportService.Options.forViewer(withViewer);
            if (zip) {
                try (ZipOutputStream z = new ZipOutputStream(Files.newOutputStream(out));
                        ExportService.Sink sink = new ExportService.ZipSink(z)) {
                    export.write(selections, opts, sink, job.progress);
                }
            } else {
                try (ExportService.Sink sink = new ExportService.DirSink(out)) {
                    export.write(selections, opts, sink, job.progress);
                }
            }
            job.outputPath = out.toString();
            job.state = State.DONE;
        } catch (ExportService.CancelledException e) {
            removeQuietly(out);
            job.state = State.CANCELLED;
        } catch (Exception e) {
            log.warn("[export] job {} failed", job.id, e);
            removeQuietly(out);
            job.error = e.getMessage() != null ? e.getMessage() : e.toString();
            job.state = State.FAILED;
        } finally {
            job.finishedAt = System.currentTimeMillis();
        }
    }

    /** 上書きしない名前（既にあれば {@code 名前 (2)}）。 */
    static Path uniqueIn(Path dir, String name, String ext) {
        Path p = dir.resolve(name + ext);
        for (int i = 2; Files.exists(p) && i < 10000; i++) {
            p = dir.resolve(name + " (" + i + ")" + ext);
        }
        return p;
    }

    private static void removeQuietly(Path p) {
        if (p == null || !Files.exists(p)) {
            return;
        }
        try (Stream<Path> s = Files.walk(p)) {
            s.sorted(Comparator.reverseOrder()).forEach(x -> {
                try {
                    Files.deleteIfExists(x);
                } catch (IOException ignore) {
                    // ベストエフォート
                }
            });
        } catch (IOException ignore) {
            // ベストエフォート
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
