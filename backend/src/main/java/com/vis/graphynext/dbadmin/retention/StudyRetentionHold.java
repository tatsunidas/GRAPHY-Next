/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/** 利用者が「ロック」した検査（自動削除から保護する）。手動の削除には効かない。 */
@Entity
@Table(name = "study_retention_hold")
public class StudyRetentionHold {

    @Id
    @Column(length = 255)
    private String studyInstanceUid;

    private Instant lockedAt;

    protected StudyRetentionHold() {
        // JPA 用
    }

    public StudyRetentionHold(String studyInstanceUid, Instant lockedAt) {
        this.studyInstanceUid = studyInstanceUid;
        this.lockedAt = lockedAt;
    }

    public String getStudyInstanceUid() {
        return studyInstanceUid;
    }

    public Instant getLockedAt() {
        return lockedAt;
    }
}
