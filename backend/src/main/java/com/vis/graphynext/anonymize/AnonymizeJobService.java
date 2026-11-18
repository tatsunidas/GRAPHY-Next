/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.activity.ActiveWork;
import com.vis.graphynext.compute.ComputeDatasetService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import jakarta.annotation.PreDestroy;
import org.dcm4che3.data.Tag;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * web の匿名化をジョブとして回す（PACS から1枚ずつ取り、匿名化して、サーバーの一時フォルダに ZIP を作る）。
 *
 * <p>🔴 <b>匿名化できなかった画像が1枚でもあれば ZIP は渡さない</b>（FAILED）。取得は失敗しうる
 * （ネットワーク・PACS の負荷）ので、ストリームで流すと途中の失敗が利用者に伝わらず、欠けた ZIP が
 * 全件に見える。ジョブにすると、全件そろってから渡せる。
 *
 * <p>同時に走るのは {@code max-jobs} 件まで、超過は待ち行列（QUEUED）。ZIP は受け取ったら消え、
 * 受け取られなくても {@code ttl-minutes} で消える。焼き込みマスクは要求ごとに持ち、
 * サーバー全体の {@link AnonymizeMaskStore} は使わない（利用者どうしで混ざらないように）。
 */
@Service
@Profile("web")
public class AnonymizeJobService implements ActiveWork {

    private static final Logger log = LoggerFactory.getLogger(AnonymizeJobService.class);
    private static final int MAX_REPORTED_ERRORS = 5;
    /** 1 回の STOW に載せる枚数（テストで小さくする）。 */
    int stowBatch = 20;

    public enum State { QUEUED, RUNNING, DONE, FAILED, CANCELLED }

    /** 状態の応答。{@code errors} は先頭の数件、{@code errorCount} は全件数。 */
    public record Status(String jobId, State state, int total, int processed, int instances, int burnedInstances,
            int notBurnedInstances, int partiallyBurnedInstances, Long usedSeed, int errorCount, List<String> errors,
            String error, long expiresAt, String output, int stored, String reason, int slices) {
    }

    private static final class Job {
        final String id = UUID.randomUUID().toString();
        final Path dir;
        final boolean stow;
        /** NIfTI の書き出しジョブ（出力は {@code out.nii.gz}）。 */
        final boolean nifti;
        volatile String reason;
        volatile int slices;
        final AtomicInteger stored = new AtomicInteger();
        volatile State state = State.QUEUED;
        volatile int total = -1;
        final AtomicInteger processed = new AtomicInteger();
        volatile AnonymizeService.Result result;
        volatile String error;
        volatile long finishedAt;
        volatile Future<?> future;

        Job(Path dir, boolean stow, boolean nifti) {
            this.dir = dir;
            this.stow = stow;
            this.nifti = nifti;
        }

        Path zip() {
            return dir.resolve("out.zip");
        }

        Path niftiFile() {
            return dir.resolve("out.nii.gz");
        }
    }

    private final AnonymizeService service;
    private final ComputeDatasetService datasets;
    private final WebDicomDataService web;
    private final Path root;
    private final long ttlMillis;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ThreadPoolExecutor workers;
    /** NIfTI の書き出し専用。体積を丸ごとメモリに持つ（上限 1 GiB）ので、同時に 1 件だけ走らせる。 */
    private final ThreadPoolExecutor niftiWorkers;
    private final ScheduledExecutorService sweeper = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "anonymize-sweep");
        t.setDaemon(true);
        return t;
    });

    @Autowired
    public AnonymizeJobService(AnonymizeService service, ComputeDatasetService datasets, WebDicomDataService web,
            @Value("${graphy.web.anonymize.max-jobs:4}") int maxJobs,
            @Value("${graphy.web.anonymize.ttl-minutes:30}") long ttlMinutes) {
        this(service, datasets, web, Path.of(System.getProperty("java.io.tmpdir"), "graphy-anon-jobs"), maxJobs,
                TimeUnit.MINUTES.toMillis(ttlMinutes));
    }

    AnonymizeJobService(AnonymizeService service, WebDicomDataService web, Path root, int maxJobs, long ttlMillis) {
        this(service, null, web, root, maxJobs, ttlMillis);
    }

    AnonymizeJobService(AnonymizeService service, ComputeDatasetService datasets, WebDicomDataService web, Path root,
            int maxJobs, long ttlMillis) {
        this.service = service;
        this.datasets = datasets;
        this.web = web;
        this.root = root;
        this.ttlMillis = ttlMillis;
        this.workers = new ThreadPoolExecutor(maxJobs, maxJobs, 0L, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>(),
                r -> {
                    Thread t = new Thread(r, "anonymize-job");
                    t.setDaemon(true);
                    return t;
                });
        this.niftiWorkers = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>(), r -> {
            Thread t = new Thread(r, "nifti-job");
            t.setDaemon(true);
            return t;
        });
        deleteTree(root); // 前回の異常終了で残った一時ファイル
        sweeper.scheduleWithFixedDelay(() -> sweep(System.currentTimeMillis()), 1, 1, TimeUnit.MINUTES);
    }

    /** ジョブを登録する。{@code masks} はシリーズ UID → マスク（無ければ空）。 */
    public Status submit(List<String> studyUids, AnonymizeConfig cfg, boolean burnIn,
            Map<String, AnonymizeMaskStore.SeriesMask> masks) throws IOException {
        return submit(studyUids, cfg, burnIn, masks, false);
    }

    /** {@code stow} なら ZIP ではなく、全件の匿名化が済んでから PACS へ新しいスタディとして保存する。 */
    public Status submit(List<String> studyUids, AnonymizeConfig cfg, boolean burnIn,
            Map<String, AnonymizeMaskStore.SeriesMask> masks, boolean stow) throws IOException {
        Files.createDirectories(root);
        Job job = new Job(Files.createTempDirectory(root, "job-"), stow, false);
        jobs.put(job.id, job);
        job.future = workers.submit(() -> run(job, studyUids, cfg, burnIn, masks));
        return statusOf(job);
    }

    /**
     * 1 シリーズを NIfTI にするジョブを登録する（段 2b）。断る理由は {@link Status#reason()}（standalone の 422 と同じコード）。
     * 出力は {@link #niftiOf} で 1 回だけ受け取れる。
     */
    public Status submitNifti(String studyUid, String seriesUid) throws IOException {
        Files.createDirectories(root);
        Job job = new Job(Files.createTempDirectory(root, "job-"), false, true);
        jobs.put(job.id, job);
        job.future = niftiWorkers.submit(() -> runNifti(job, studyUid, seriesUid));
        return statusOf(job);
    }

    private void runNifti(Job job, String studyUid, String seriesUid) {
        if (job.state == State.CANCELLED) {
            return;
        }
        job.state = State.RUNNING;
        try {
            if (datasets == null) {
                fail(job, "NIfTI の書き出しが組み込まれていません");
                return;
            }
            WebAnonymizeSource source = new WebAnonymizeSource(web, List.of(studyUid), job.dir.resolve("src"), seriesUid);
            job.total = source.list().size();
            if (job.total == 0) {
                job.reason = "series-not-found";
                fail(job, "対象のインスタンスが PACS にありません");
                return;
            }
            ComputeDatasetService.WebNifti r;
            try (OutputStream fo = Files.newOutputStream(job.niftiFile())) {
                r = datasets.writeNiftiFromSource(source, fo, job.processed::incrementAndGet);
            }
            if (job.state == State.CANCELLED) {
                return;
            }
            job.slices = r.instances();
            job.finishedAt = System.currentTimeMillis();
            job.state = State.DONE;
        } catch (ComputeDatasetService.DatasetRefused e) {
            job.reason = e.reason();
            fail(job, e.getMessage());
        } catch (CancellationException e) {
            cleanup(job, State.CANCELLED);
        } catch (Exception e) {
            log.warn("nifti job {} failed", job.id, e);
            fail(job, e.getMessage() == null ? e.toString() : e.getMessage());
        } finally {
            deleteTree(job.dir.resolve("src"));
        }
    }

    private void run(Job job, List<String> studyUids, AnonymizeConfig cfg, boolean burnIn,
            Map<String, AnonymizeMaskStore.SeriesMask> masks) {
        if (job.state == State.CANCELLED) {
            return;
        }
        job.state = State.RUNNING;
        try {
            WebAnonymizeSource source = new WebAnonymizeSource(web, studyUids, job.dir.resolve("src"));
            job.total = source.list().size();
            if (job.total == 0) {
                fail(job, "対象のインスタンスが PACS にありません");
                return;
            }
            AnonymizeService.Result r;
            if (job.stow) {
                Path out = Files.createDirectories(job.dir.resolve("out"));
                r = service.anonymize(source, cfg, burnIn, masks::get, true, (ds, tsuid) -> {
                    try (OutputStream fo = Files.newOutputStream(out.resolve(job.processed.get() + ".dcm"))) {
                        AnonymizeService.writeDicom(ds, tsuid, fo);
                    }
                    job.processed.incrementAndGet();
                });
            } else {
                try (OutputStream fo = Files.newOutputStream(job.zip());
                        ZipOutputStream zos = new ZipOutputStream(fo)) {
                    r = service.anonymize(source, cfg, burnIn, masks::get, true, (ds, tsuid) -> {
                        String name = ds.getString(Tag.StudyInstanceUID) + "/" + ds.getString(Tag.SeriesInstanceUID)
                                + "/" + ds.getString(Tag.SOPInstanceUID) + ".dcm";
                        zos.putNextEntry(new ZipEntry(name));
                        AnonymizeService.writeDicom(ds, tsuid, zos);
                        zos.closeEntry();
                        job.processed.incrementAndGet();
                    });
                }
            }
            job.result = r;
            if (!r.errors().isEmpty()) {
                fail(job, "匿名化できなかった画像が " + r.errors().size() + " 枚あるため、ZIP は作りませんでした");
                return;
            }
            if (job.state == State.CANCELLED) {
                return;
            }
            if (job.stow && !store(job)) {
                return;
            }
            job.finishedAt = System.currentTimeMillis();
            job.state = State.DONE;
        } catch (CancellationException e) {
            cleanup(job, State.CANCELLED);
        } catch (Exception e) {
            log.warn("anonymize job {} failed", job.id, e);
            fail(job, e.getMessage() == null ? e.toString() : e.getMessage());
        } finally {
            deleteTree(job.dir.resolve("src"));
        }
    }

    /**
     * 匿名化済みの画像を PACS へ保存する。保存済みの分は PACS から取り消せないので、止まったときは
     * 「保存済み N 枚」を状態に残す。失敗・中止なら false。
     */
    private boolean store(Job job) throws IOException {
        List<Path> files;
        try (Stream<Path> s = Files.list(job.dir.resolve("out"))) {
            files = s.sorted().toList();
        }
        for (int i = 0; i < files.size(); i += stowBatch) {
            if (Thread.currentThread().isInterrupted() || job.state == State.CANCELLED) {
                cleanup(job, State.CANCELLED);
                return false;
            }
            List<byte[]> batch = new ArrayList<>();
            for (Path f : files.subList(i, Math.min(i + stowBatch, files.size()))) {
                batch.add(Files.readAllBytes(f));
            }
            WebDicomDataService.StowResult sr;
            try {
                sr = web.storeInstancesChecked(batch);
            } catch (RuntimeException e) {
                fail(job, "PACS への保存に失敗しました（保存済み " + job.stored.get() + " 枚／全 " + files.size() + " 枚）: "
                        + e.getMessage());
                return false;
            }
            job.stored.addAndGet(sr.stored());
            if (!sr.failures().isEmpty()) {
                fail(job, "PACS が " + sr.failures().size() + " 枚の保存を拒否しました（保存済み " + job.stored.get()
                        + " 枚／全 " + files.size() + " 枚）: "
                        + String.join(" / ", sr.failures().subList(0, Math.min(MAX_REPORTED_ERRORS, sr.failures().size()))));
                return false;
            }
        }
        return true;
    }

    private void fail(Job job, String message) {
        job.error = message;
        cleanup(job, State.FAILED);
    }

    /** ZIP と一時ファイルを消して、終わった状態にする（失敗・中止の出力は渡さない）。 */
    private void cleanup(Job job, State end) {
        deleteTree(job.dir);
        job.finishedAt = System.currentTimeMillis();
        job.state = end;
    }

    public Status status(String id) {
        Job job = jobs.get(id);
        return job == null ? null : statusOf(job);
    }

    /** DONE の ZIP のパス。まだ（または失敗・期限切れ）なら null。 */
    public Path zipOf(String id) {
        Job job = jobs.get(id);
        return job != null && !job.nifti && job.state == State.DONE && Files.exists(job.zip()) ? job.zip() : null;
    }

    /** DONE の NIfTI のパス。まだ（または失敗・期限切れ・NIfTI ジョブでない）なら null。 */
    public Path niftiOf(String id) {
        Job job = jobs.get(id);
        return job != null && job.nifti && job.state == State.DONE && Files.exists(job.niftiFile()) ? job.niftiFile() : null;
    }

    /** 受け取り後などにジョブごと消す。 */
    public void discard(String id) {
        Job job = jobs.remove(id);
        if (job != null) {
            deleteTree(job.dir);
        }
    }

    /** 中止して消す。実行中なら止まるまで待たずに状態を CANCELLED にする。 */
    public boolean cancel(String id) {
        Job job = jobs.get(id);
        if (job == null) {
            return false;
        }
        if (job.state == State.QUEUED || job.state == State.RUNNING) {
            job.state = State.CANCELLED;
            Future<?> f = job.future;
            if (f != null) {
                f.cancel(true);
            }
        }
        jobs.remove(id);
        deleteTree(job.dir);
        return true;
    }

    /** 終わってから ttl を過ぎたジョブを消す。 */
    void sweep(long now) {
        for (Job job : new ArrayList<>(jobs.values())) {
            boolean over = job.finishedAt > 0 && now - job.finishedAt > ttlMillis;
            if (over && job.state != State.QUEUED && job.state != State.RUNNING) {
                discard(job.id);
            }
        }
    }

    int jobCount() {
        return jobs.size();
    }

    private Status statusOf(Job job) {
        AnonymizeService.Result r = job.result;
        List<String> errs = r == null ? List.of()
                : r.errors().subList(0, Math.min(MAX_REPORTED_ERRORS, r.errors().size()));
        return new Status(job.id, job.state, job.total, job.processed.get(),
                r == null ? 0 : r.instances(), r == null ? 0 : r.burnedInstances(),
                r == null ? 0 : r.notBurnedInstances(), r == null ? 0 : r.partiallyBurnedInstances(),
                r == null ? null : r.usedSeed(), r == null ? 0 : r.errors().size(), errs, job.error,
                job.finishedAt > 0 ? job.finishedAt + ttlMillis : 0, job.nifti ? "nifti" : job.stow ? "stow" : "zip",
                job.stored.get(), job.reason, job.slices);
    }

    @PreDestroy
    void shutdown() {
        sweeper.shutdownNow();
        workers.shutdownNow();
        niftiWorkers.shutdownNow();
        deleteTree(root);
    }

    private static void deleteTree(Path p) {
        if (p == null || !Files.exists(p)) {
            return;
        }
        try (Stream<Path> s = Files.walk(p)) {
            s.sorted(Comparator.reverseOrder()).forEach(x -> {
                try {
                    Files.deleteIfExists(x);
                } catch (IOException ignored) {
                    // 使用中などで消せなければ、次回起動時の掃除に任せる
                }
            });
        } catch (IOException ignored) {
            // 同上
        }
    }

    @Override
    public String kind() {
        return "anonymize";
    }

    @Override
    public int activeCount() {
        return (int) jobs.values().stream()
                .filter(j -> j.state == State.QUEUED
                        || j.state == State.RUNNING)
                .count();
    }

    @Override
    public void cancelAll() {
        // cancel は Map から消すので、先にキーを写してから回す
        new ArrayList<>(jobs.keySet()).forEach(this::cancel);
    }
}
