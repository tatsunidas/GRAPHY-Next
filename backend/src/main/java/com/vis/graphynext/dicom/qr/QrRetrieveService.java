/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.web.WebDicomDataService;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

/**
 * QR Retrieve（C-GET）の非同期ジョブ管理＋進捗。
 *
 * <p>両モードとも getscu でソース PACS から一時ディレクトリへ取得し、取得後に格納する:
 * standalone は {@link DicomStorageService#ingest} でローカル索引へ、web は STOW-RS で dcm4chee へ。
 * 進捗は取得中の一時ディレクトリのファイル数を監視してベストエフォートで更新する。
 */
@Service
public class QrRetrieveService {

    private static final Logger log = LoggerFactory.getLogger(QrRetrieveService.class);

    private final DimseQrService qr;
    private final DicomStorageService storage;
    private final ObjectProvider<WebDicomDataService> webProvider;

    private final ExecutorService exec = Executors.newFixedThreadPool(2);
    private final ConcurrentHashMap<String, Job> jobs = new ConcurrentHashMap<>();
    private final AtomicLong seq = new AtomicLong();

    public QrRetrieveService(DimseQrService qr, DicomStorageService storage,
                             ObjectProvider<WebDicomDataService> webProvider) {
        this.qr = qr;
        this.storage = storage;
        this.webProvider = webProvider;
    }

    /** ジョブ状態（フェーズ: retrieving → storing → done/error）。 */
    public record JobStatus(int expected, int received, int stored, boolean done, boolean success,
                            String phase, String message) {
    }

    private static final class Job {
        volatile int expected;
        volatile int received;
        volatile int stored;
        volatile boolean done;
        volatile boolean success;
        volatile String phase = "retrieving";
        volatile String message = "";
    }

    /** リトリーブ要求。seriesUid が null/空ならスタディ全体。 */
    public String start(String host, int port, String calledAet, String studyUid, String seriesUid, int expected) {
        String id = "qrjob-" + seq.incrementAndGet();
        Job job = new Job();
        job.expected = Math.max(0, expected);
        jobs.put(id, job);
        exec.submit(() -> run(id, job, host, port, calledAet, studyUid, seriesUid));
        return id;
    }

    public JobStatus status(String id) {
        Job j = jobs.get(id);
        if (j == null) {
            return null;
        }
        return new JobStatus(j.expected, j.received, j.stored, j.done, j.success, j.phase, j.message);
    }

    private void run(String id, Job job, String host, int port, String calledAet, String studyUid, String seriesUid) {
        Path dir = null;
        Thread watcher = null;
        try {
            dir = Files.createTempDirectory("graphy-qr-ret-");
            final Path watched = dir;
            // 取得進捗ウォッチャ: 一時ディレクトリのファイル数を received に反映。
            watcher = new Thread(() -> {
                while (!job.done) {
                    job.received = countFiles(watched);
                    try {
                        Thread.sleep(500);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            });
            watcher.setDaemon(true);
            watcher.start();

            // 1) C-GET でソース PACS から取得
            qr.retrieveTo(host, port, calledAet, studyUid, seriesUid, dir);
            job.received = countFiles(dir);

            // 2) 格納フェーズ
            job.phase = "storing";
            WebDicomDataService web = webProvider.getIfAvailable();
            if (web != null) {
                // web: dcm4chee へ STOW-RS（ディレクトリ一括）。
                qr.stowDir(dir);
                job.stored = job.received;
            } else {
                // standalone: ローカル索引へ取込。
                int n = 0;
                try (Stream<Path> walk = Files.walk(dir)) {
                    for (Path f : walk.filter(Files::isRegularFile).toList()) {
                        try {
                            storage.ingest(f);
                            n++;
                            job.stored = n;
                        } catch (Exception e) {
                            log.warn("QR 取込失敗: {} ({})", f, e.toString());
                        }
                    }
                }
            }
            job.success = true;
            job.phase = "done";
            log.info("QR retrieve 完了 job={} study={} series={} received={} stored={}",
                    id, studyUid, seriesUid, job.received, job.stored);
        } catch (Exception e) {
            job.success = false;
            job.phase = "error";
            job.message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            log.warn("QR retrieve 失敗 job={}: {}", id, e.toString());
        } finally {
            job.done = true;
            if (watcher != null) {
                watcher.interrupt();
            }
            if (dir != null) {
                deleteQuietly(dir);
            }
        }
    }

    private static int countFiles(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            return (int) walk.filter(Files::isRegularFile).count();
        } catch (IOException e) {
            return 0;
        }
    }

    private static void deleteQuietly(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted((a, b) -> b.getNameCount() - a.getNameCount()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignore) {
                    // ベストエフォート
                }
            });
        } catch (IOException ignore) {
            // ベストエフォート
        }
    }
}
