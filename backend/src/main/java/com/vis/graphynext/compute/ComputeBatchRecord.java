/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * 計算ジョブの台帳（一括）。同じコード・同じ計算機・同じ設定で投げた 1 回分。段 1 は {@code runJob} 1 回が 1 バッチ・1 ジョブ。
 * 設計: fw/remote-compute-design.md（計算ジョブの台帳）。
 *
 * <p>🔴 <b>患者名・患者 ID・生年月日・検査記述の列は作らない</b>。画面に出すときに保管庫から UID で引く。
 * 接続先の URL のトークンも持たない（メモリの登録簿だけ）。
 */
@Entity
@Table(name = "compute_batch")
class ComputeBatchRecord {

    @Id
    @Column(length = 64)
    String id;

    @Column(length = 128, nullable = false)
    String pluginId;
    @Column(length = 256)
    String pluginName;
    @Column(length = 64)
    String pluginVersion;
    /** 導入した zip の SHA-256。同梱・開発配置など台帳に無いものは null（不明）。 */
    @Column(length = 64)
    String pluginPackageSha256;

    /** 実行したコード（再実行に要る。{@code CodeInspector} を通ったもの）。 */
    @Lob
    @Column(nullable = false)
    String code;
    @Column(length = 64, nullable = false)
    String codeSha256;

    @Column(length = 128, nullable = false)
    String endpointId;
    @Column(length = 256)
    String endpointLabel;
    /** jupyter / colab / local。 */
    @Column(length = 16)
    String endpointKind;
    @Column(length = 256)
    String endpointHost;
    boolean plaintext;

    int timeoutSec;
    /** 対話の 1 回（runJob）由来か。 */
    boolean interactive = true;
    @Column(length = 400)
    String pausedReason;
    @Column(length = 64)
    String consentRequestId;

    Instant createdAt;

    protected ComputeBatchRecord() {
    }

    ComputeBatchRecord(String id) {
        this.id = id;
    }
}
