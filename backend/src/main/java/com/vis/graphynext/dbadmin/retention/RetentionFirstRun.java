/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * 有効にした直後の 1 回目の対象（利用者が試算で見た検査）。行がある間、実行はこの検査だけを消す。
 * 1 回目が終わったら空にする。
 */
@Entity
@Table(name = "retention_first_run")
public class RetentionFirstRun {

    @Id
    @Column(length = 255)
    private String studyInstanceUid;

    protected RetentionFirstRun() {
        // JPA 用
    }

    public RetentionFirstRun(String studyInstanceUid) {
        this.studyInstanceUid = studyInstanceUid;
    }

    public String getStudyInstanceUid() {
        return studyInstanceUid;
    }
}
