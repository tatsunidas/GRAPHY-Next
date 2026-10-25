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

/**
 * 自動削除の記録（1 検査 1 行）。「削除の記録」画面とログの突き合わせ用。患者名はここだけに置く
 * （アプリのログには出さない）。result は deleted（全部消せた）／partial（一部の画像を消せず索引に残した）／
 * failed（1 枚も外せなかった・予期しない例外）／skipped（実行の直前の再確認で外した）。
 */
@Entity
@Table(name = "retention_event", indexes = {
        @Index(name = "ix_retention_event_at", columnList = "at"),
        @Index(name = "ix_retention_event_run", columnList = "runId")
})
public class RetentionEvent {

    @Id
    @Column(length = 64)
    private String id;
    @Column(length = 64)
    private String runId;
    private Instant at;
    @Column(length = 255)
    private String studyUid;
    private String patientId;
    private String patientName;
    private String studyDate;
    private String modality;
    private long instances;
    private long sizeBytes;
    @Column(length = 32)
    private String reason;
    @Column(length = 16)
    private String result;
    private int failedFiles;
    @Column(length = 200)
    private String errorKind;

    protected RetentionEvent() {
        // JPA 用
    }

    public RetentionEvent(String id, String runId, Instant at, String studyUid, String patientId, String patientName,
                          String studyDate, String modality, long instances, long sizeBytes, String reason,
                          String result, int failedFiles, String errorKind) {
        this.id = id;
        this.runId = runId;
        this.at = at;
        this.studyUid = studyUid;
        this.patientId = patientId;
        this.patientName = patientName;
        this.studyDate = studyDate;
        this.modality = modality;
        this.instances = instances;
        this.sizeBytes = sizeBytes;
        this.reason = reason;
        this.result = result;
        this.failedFiles = failedFiles;
        this.errorKind = errorKind;
    }

    public String getId() {
        return id;
    }

    public String getRunId() {
        return runId;
    }

    public Instant getAt() {
        return at;
    }

    public String getStudyUid() {
        return studyUid;
    }

    public String getPatientId() {
        return patientId;
    }

    public String getPatientName() {
        return patientName;
    }

    public String getStudyDate() {
        return studyDate;
    }

    public String getModality() {
        return modality;
    }

    public long getInstances() {
        return instances;
    }

    public long getSizeBytes() {
        return sizeBytes;
    }

    public String getReason() {
        return reason;
    }

    public String getResult() {
        return result;
    }

    public int getFailedFiles() {
        return failedFiles;
    }

    public String getErrorKind() {
        return errorKind;
    }
}
