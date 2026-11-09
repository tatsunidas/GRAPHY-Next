/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** 事前取得した検査の保護期限。{@code untilMs}（epoch ms）より前は自動削除の対象から外す。 */
@Entity
@Table(name = "prefetch_hold")
public class PrefetchHold {

    @Id
    @Column(length = 255)
    private String studyUid;
    private long untilMs;

    protected PrefetchHold() {
    }

    public PrefetchHold(String studyUid, long untilMs) {
        this.studyUid = studyUid;
        this.untilMs = untilMs;
    }

    public String getStudyUid() { return studyUid; }
    public long getUntilMs() { return untilMs; }
    public void extendTo(long ms) { this.untilMs = Math.max(this.untilMs, ms); }
}
