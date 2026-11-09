/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** 事前取得の 1 回の実行の記録。患者名・患者 ID は持たない（件数と検査 UID のみ）。 */
@Entity
@Table(name = "prefetch_run")
public class PrefetchRun {

    public static final String RUNNING = "RUNNING";
    public static final String COMPLETE = "COMPLETE";
    /** 通信先の障害で途中までになった（残りは次回の再試行で拾う）。 */
    public static final String INTERRUPTED = "INTERRUPTED";
    /** 実行できなかった（設定の不備・予約一覧の取得失敗など）。 */
    public static final String ERROR = "ERROR";

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    /** 定時の枠（日付と時刻）。手動は "manual"。同じ枠が COMPLETE なら二度走らせない。 */
    @Column(length = 40, nullable = false)
    private String slotKey;
    @Column(length = 16, nullable = false)
    private String triggerKind;
    private long startedAt;
    private Long finishedAt;
    @Column(length = 16, nullable = false)
    private String status;
    @Column(length = 40)
    private String targetDays;
    private int patients;
    private int found;
    private int retrieved;
    private int existing;
    private int failed;
    /** 通信先の障害で未処理のまま残った患者数。 */
    private int pending;
    @Column(length = 400)
    private String error;

    protected PrefetchRun() {
    }

    public PrefetchRun(String slotKey, String trigger, long startedAt, String targetDays) {
        this.slotKey = slotKey;
        this.triggerKind = trigger;
        this.startedAt = startedAt;
        this.targetDays = targetDays;
        this.status = RUNNING;
    }

    public Long getId() { return id; }
    public String getSlotKey() { return slotKey; }
    public String getTriggerKind() { return triggerKind; }
    public long getStartedAt() { return startedAt; }
    public Long getFinishedAt() { return finishedAt; }
    public String getStatus() { return status; }
    public String getTargetDays() { return targetDays; }
    public int getPatients() { return patients; }
    public int getFound() { return found; }
    public int getRetrieved() { return retrieved; }
    public int getExisting() { return existing; }
    public int getFailed() { return failed; }
    public int getPending() { return pending; }
    public String getError() { return error; }

    void finish(String status, long at, int patients, int found, int retrieved, int existing, int failed,
                int pending, String error) {
        this.status = status;
        this.finishedAt = at;
        this.patients = patients;
        this.found = found;
        this.retrieved = retrieved;
        this.existing = existing;
        this.failed = failed;
        this.pending = pending;
        this.error = error == null || error.length() <= 400 ? error : error.substring(0, 400);
    }
}
