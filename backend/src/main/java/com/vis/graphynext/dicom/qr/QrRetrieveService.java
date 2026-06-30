/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import com.vis.graphynext.settings.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * QR Retrieve（C-MOVE）の非同期ジョブ管理＋進捗。
 *
 * <p>両モードとも C-MOVE でソース PACS から移動先へ送らせる:
 * standalone は移動先＝自局 AE（自前 SCP が受信して索引化）、web は移動先＝dcm4chee の AE
 * （{@code dicom.webMoveDestAet} 設定）。進捗は移動先の保存件数（standalone=ローカル索引 /
 * web=QIDO）を expected と比較してベストエフォートで更新する。
 *
 * <p>前提: C-MOVE はソース PACS 側に移動先 AE（自局 AE / dcm4chee）が登録済みであること（QR の標準設定）。
 */
@Service
public class QrRetrieveService {

    private static final Logger log = LoggerFactory.getLogger(QrRetrieveService.class);

    /** web モードの C-MOVE 宛先 AE（dcm4chee の AE タイトル）を保存する Settings キー。 */
    public static final String WEB_MOVE_DEST_AET_KEY = "dicom.webMoveDestAet";

    private final DimseQrService qr;
    private final DicomStorageService storage;
    private final DicomProperties props;
    private final SettingsService settings;
    private final ObjectProvider<WebDicomDataService> webProvider;

    private final ExecutorService exec = Executors.newFixedThreadPool(2);
    private final ConcurrentHashMap<String, Job> jobs = new ConcurrentHashMap<>();
    private final AtomicLong seq = new AtomicLong();

    public QrRetrieveService(DimseQrService qr, DicomStorageService storage, DicomProperties props,
                             SettingsService settings, ObjectProvider<WebDicomDataService> webProvider) {
        this.qr = qr;
        this.storage = storage;
        this.props = props;
        this.settings = settings;
        this.webProvider = webProvider;
    }

    /** ジョブ状態（フェーズ: moving → done/error）。received=移動先の保存件数。 */
    public record JobStatus(int expected, int received, int stored, boolean done, boolean success,
                            String phase, String message) {
    }

    private static final class Job {
        volatile int expected;
        volatile int received;
        volatile boolean done;
        volatile boolean success;
        volatile String phase = "moving";
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
        return new JobStatus(j.expected, j.received, j.received, j.done, j.success, j.phase, j.message);
    }

    private void run(String id, Job job, String host, int port, String calledAet, String studyUid, String seriesUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        Thread watcher = null;
        try {
            // 移動先 AE: standalone=自局 / web=dcm4chee（設定）。
            String destAet;
            if (web != null) {
                destAet = settings.getAll().getOrDefault(WEB_MOVE_DEST_AET_KEY, "");
                if (destAet == null || destAet.isBlank()) {
                    throw new IllegalStateException(
                            "web モードの C-MOVE 宛先 AE（dicom.webMoveDestAet）が未設定です（環境設定の Query/Retrieve）");
                }
            } else {
                destAet = props.getLocalAeTitle();
            }

            // 進捗ウォッチャ: 移動先の保存件数を received に反映。
            final boolean isWeb = web != null;
            watcher = new Thread(() -> {
                while (!job.done) {
                    job.received = (int) countStored(isWeb ? web : null, studyUid, seriesUid);
                    try {
                        Thread.sleep(700);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            });
            watcher.setDaemon(true);
            watcher.start();

            // C-MOVE 実行（スタディ全体 or シリーズ）。
            if (seriesUid != null && !seriesUid.isBlank()) {
                qr.moveSeries(host, port, calledAet, studyUid, seriesUid, destAet);
            } else {
                qr.moveStudy(host, port, calledAet, studyUid, destAet);
            }

            job.received = (int) countStored(web, studyUid, seriesUid);
            job.success = true;
            job.phase = "done";
            log.info("QR C-MOVE 完了 job={} study={} series={} dest={} stored={}",
                    id, studyUid, seriesUid, destAet, job.received);
        } catch (Exception e) {
            job.success = false;
            job.phase = "error";
            job.message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            log.warn("QR C-MOVE 失敗 job={}: {}", id, e.toString());
        } finally {
            job.done = true;
            if (watcher != null) {
                watcher.interrupt();
            }
        }
    }

    /** 移動先の保存件数（web=QIDO / standalone=ローカル索引）。 */
    private long countStored(WebDicomDataService web, String studyUid, String seriesUid) {
        try {
            return web != null ? web.storedCount(studyUid, seriesUid) : storage.storedCount(studyUid, seriesUid);
        } catch (Exception e) {
            return 0;
        }
    }
}
