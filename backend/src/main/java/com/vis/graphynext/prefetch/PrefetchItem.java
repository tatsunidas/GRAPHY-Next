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

/** 事前取得で扱った検査 1 件の結果。 */
@Entity
@Table(name = "prefetch_item")
public class PrefetchItem {

    public static final String RETRIEVED = "RETRIEVED";
    public static final String EXISTING = "EXISTING";
    public static final String FAILED = "FAILED";

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @Column(nullable = false)
    private long runId;
    @Column(length = 255)
    private String studyUid;
    @Column(length = 16, nullable = false)
    private String status;
    @Column(length = 400)
    private String error;

    protected PrefetchItem() {
    }

    public PrefetchItem(long runId, String studyUid, String status, String error) {
        this.runId = runId;
        this.studyUid = studyUid;
        this.status = status;
        this.error = error == null || error.length() <= 400 ? error : error.substring(0, 400);
    }

    public long getRunId() { return runId; }
    public String getStudyUid() { return studyUid; }
    public String getStatus() { return status; }
    public String getError() { return error; }
}
