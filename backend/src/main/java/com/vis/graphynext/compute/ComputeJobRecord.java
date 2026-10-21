/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * 計算ジョブの台帳（1 件）。{@link ComputeBatchRecord} の 1 組＝1 回の試行。
 *
 * <p>🔴 患者名・患者 ID は持たない（{@link ComputeBatchRecord} と同じ）。入力の元の UID（{@code inputRefs}）は
 * 保管庫と同じ PC の中だけで、再実行と「どのシリーズが失敗したか」の表示に要る。
 * 保管庫からシリーズを消したら、その UID を {@link ComputeJobLedger#clearSeries} で空にする。
 */
@Entity
@Table(name = "compute_job")
class ComputeJobRecord {

    /** {@code error_value} の列に入れる長さ（{@code ImportWatchItem.error} と同じ。全文はログのファイル）。 */
    static final int ERROR_VALUE_MAX = 400;

    @Id
    @Column(length = 64)
    String id;

    @Column(length = 64, nullable = false)
    String batchId;
    /** プラグインの組の名前（患者名を入れない）。 */
    @Column(length = 128)
    String itemKey;
    int attempt = 1;
    /** その試行を要求した時点の、プラグインの版（再実行で記録の版との違いを見るため）。null＝不明。 */
    @Column(length = 64)
    String pluginVersion;
    /** その試行を走らせた計算機（再実行で選び直したときにバッチの記録と違う）。null＝バッチの記録と同じ（古い行）。 */
    @Column(length = 128)
    String endpointId;
    @Column(length = 256)
    String endpointLabel;
    @Column(length = 256)
    String endpointHost;

    /** JSON: [{studyUid, seriesUid, format}]。削除されたシリーズは UID が空文字になる。 */
    @Column(length = 4000)
    String inputRefs;
    /** 監査ログ（compute-audit.jsonl）の requestId へのつなぎ。 */
    @Column(length = 64)
    String requestId;
    @Column(length = 128)
    String contentHash;
    /** H45 の jobId（プラグインのポーリング用）。 */
    @Column(length = 64)
    String pluginJobId;

    /** {@link ComputeJobStateMachine.State} の名前。 */
    @Column(length = 16, nullable = false)
    String state;
    /** upload / start / exec / download / cleanup。 */
    @Column(length = 16)
    String phase;
    double progress;
    @Column(length = 400)
    String message;

    /** {@link ComputeJobStateMachine.Reason} のコード。FAILED / INTERRUPTED のとき。 */
    @Column(length = 32)
    String reason;
    @Column(length = 200)
    String errorName;
    @Column(length = ERROR_VALUE_MAX)
    String errorValue;

    /** JSON: {python, torch, cuda, gpu}。取れなければ null。 */
    @Column(length = 2000)
    String envJson;
    /** 計算機の作業フォルダ（後始末の対象）。 */
    @Column(length = 512)
    String remoteRunDir;
    /** 計算機で起動したカーネルの id。落ちた後に孤児のカーネルを止めるのに要る。 */
    @Column(length = 64)
    String kernelId;
    /** ok / pending / failed / runtime-gone。 */
    @Column(length = 16)
    String remoteCleanup;

    Instant queuedAt;
    Instant startedAt;
    Instant finishedAt;
    long outputsBytes;
    Instant collectedAt;

    protected ComputeJobRecord() {
    }

    ComputeJobRecord(String id, String batchId) {
        this.id = id;
        this.batchId = batchId;
    }
}
