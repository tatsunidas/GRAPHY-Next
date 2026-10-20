/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * アプリが落ちた・終了したあとの片付け（起動時）。
 * <ul>
 *   <li>待ち・実行中のまま残った台帳の行を「再起動で中断」にする。</li>
 *   <li>匿名化済みデータの一時フォルダ（{@code graphy-compute-*}）の取り残しを消す。</li>
 *   <li>計算機側に残った作業フォルダの後始末は、main が接続先を登録し直した後（{@link #cleanupRemoteAsync}）。
 *       接続先の情報（トークン）はメモリにしか無いので、起動の時点ではまだできない。</li>
 * </ul>
 * 失敗しても起動は止めない。
 */
@Component
@Profile("standalone")
class ComputeJobRecovery {

    private static final Logger log = LoggerFactory.getLogger(ComputeJobRecovery.class);

    private final ComputeJobLedger ledger;
    private final ComputeDatasetService datasets;
    private final ComputeEndpointRegistry endpoints;
    private final ComputeAuditLog audit;
    private final ObjectMapper mapper;
    private final ExecutorService cleaner = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "compute-remote-cleanup");
        t.setDaemon(true);
        return t;
    });

    ComputeJobRecovery(ComputeJobLedger ledger, ComputeDatasetService datasets, ComputeEndpointRegistry endpoints,
                       ComputeAuditLog audit, ObjectMapper mapper) {
        this.ledger = ledger;
        this.datasets = datasets;
        this.endpoints = endpoints;
        this.audit = audit;
        this.mapper = mapper;
    }

    @PreDestroy
    void shutdown() {
        cleaner.shutdownNow();
    }

    @EventListener(ApplicationReadyEvent.class)
    void onReady() {
        try {
            int n = ledger.recoverInterrupted();
            if (n > 0) {
                log.info("[compute] {} job(s) left over from the last run were marked interrupted", n);
            }
        } catch (RuntimeException e) {
            log.warn("[compute] cannot recover the job ledger: {}", e.toString());
        }
        try {
            int n = datasets.sweepOrphans();
            if (n > 0) {
                log.info("[compute] removed {} leftover temporary dataset(s)", n);
            }
        } catch (RuntimeException e) {
            log.warn("[compute] cannot sweep leftover datasets: {}", e.toString());
        }
    }

    /** 接続先が（再）登録された後に、計算機に残った作業フォルダを消す。ブロックしない。 */
    void cleanupRemoteAsync() {
        cleaner.execute(this::cleanupRemote);
    }

    void cleanupRemote() {
        List<ComputeJobRecord> pending;
        try {
            pending = ledger.cleanupPending();
        } catch (RuntimeException e) {
            log.warn("[compute] cannot list pending remote cleanups: {}", e.toString());
            return;
        }
        for (ComputeJobRecord j : pending) {
            try {
                ComputeBatchRecord b = ledger.batchOf(j).orElse(null);
                if (b == null || j.remoteRunDir == null) {
                    continue;
                }
                ComputeEndpointRegistry.Entry entry = endpoints.get(b.endpointId).orElse(null);
                if (entry == null) {
                    continue; // まだ登録されていない。次に登録されたときに試す
                }
                String result;
                if ("colab".equals(entry.kind())) {
                    // ランタイムはアプリの終了で解放済み（作業フォルダごと消えている）。消す相手がいない
                    result = "runtime-gone";
                } else {
                    JupyterServerClient c = endpoints.client(entry.id(), mapper).orElse(null);
                    if (c == null) {
                        continue;
                    }
                    if (j.kernelId != null) {
                        // 落ちたアプリが起動したカーネルは計算機に残っていて、コードを走らせ続けている（作業フォルダも掴む）
                        try {
                            c.shutdownKernel(j.kernelId);
                        } catch (RuntimeException e) {
                            log.debug("[compute] cannot shut down leftover kernel of {}: {}", j.id, e.getMessage());
                        }
                    }
                    try {
                        c.delete(j.remoteRunDir);
                        result = "ok";
                    } catch (RuntimeException e) {
                        log.warn("[compute] cannot delete remote folder of {}: {}", j.id, e.getMessage());
                        result = "failed";
                    }
                }
                ledger.remoteCleanup(j.id, result);
                audit.append(audit.event("compute-remote-cleanup").put("jobId", j.id).put("endpointId", b.endpointId)
                        .put("result", result));
            } catch (RuntimeException e) {
                log.warn("[compute] remote cleanup of {} failed: {}", j.id, e.toString());
            }
        }
    }
}
