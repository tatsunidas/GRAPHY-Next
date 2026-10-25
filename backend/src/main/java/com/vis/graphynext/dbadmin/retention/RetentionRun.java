/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;

import java.time.Instant;

/** 自動削除の実行 1 回の要約。trigger は storage / daily / manual。 */
@Entity
@Table(name = "retention_run", indexes = @Index(name = "ix_retention_run_at", columnList = "at"))
public class RetentionRun {

    @Id
    @Column(length = 64)
    private String id;
    private Instant at;
    // trigger は SQL の予約語なので列名を変える
    @Column(name = "trigger_kind", length = 16)
    private String trigger;
    private int planned;
    private int deleted;
    private int partial;
    private int failed;
    private int skipped;
    private long bytesFreed;
    private boolean satisfied;
    /** 警告のコード（カンマ区切り）。例: free, protected:3, cache-mode-unsupported。 */
    @Column(length = 1000)
    private String warnings;

    protected RetentionRun() {
        // JPA 用
    }

    public RetentionRun(String id, Instant at, String trigger, int planned, int deleted, int partial, int failed,
                        int skipped, long bytesFreed, boolean satisfied, String warnings) {
        this.id = id;
        this.at = at;
        this.trigger = trigger;
        this.planned = planned;
        this.deleted = deleted;
        this.partial = partial;
        this.failed = failed;
        this.skipped = skipped;
        this.bytesFreed = bytesFreed;
        this.satisfied = satisfied;
        this.warnings = warnings;
    }

    public String getId() {
        return id;
    }

    public Instant getAt() {
        return at;
    }

    public String getTrigger() {
        return trigger;
    }

    public int getPlanned() {
        return planned;
    }

    public int getDeleted() {
        return deleted;
    }

    public int getPartial() {
        return partial;
    }

    public int getFailed() {
        return failed;
    }

    public int getSkipped() {
        return skipped;
    }

    public long getBytesFreed() {
        return bytesFreed;
    }

    public boolean isSatisfied() {
        return satisfied;
    }

    public String getWarnings() {
        return warnings;
    }

    /** 利用者に知らせる価値があるか（何か消した・失敗した・条件を満たせなかった・警告がある）。 */
    public boolean notable() {
        return deleted + partial + failed > 0 || !satisfied || (warnings != null && !warnings.isEmpty());
    }
}
