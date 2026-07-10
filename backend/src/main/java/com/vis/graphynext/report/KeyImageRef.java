/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.Lob;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

/**
 * レポート 1 件が参照する「キー画像」1 枚。確定時（フェーズ2）に Key Object Selection
 * Document(KO) の IMAGE content item として書き出される。
 */
@Entity
@Table(name = "key_image_ref", indexes = {
        @Index(name = "ix_keyimage_report", columnList = "report_id")
})
public class KeyImageRef {

    @Id
    @Column(length = 36)
    private String id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "report_id", nullable = false)
    private Report report;

    @Column(nullable = false, length = 64)
    private String sopInstanceUid;

    @Column(nullable = false, length = 64)
    private String seriesInstanceUid;

    /** multi-frame インスタンス内のフレーム番号（1 始まり）。単一フレームなら null。 */
    private Integer frameNumber;

    @Column(length = 500)
    private String label;

    @Lob
    private String annotation;

    private int sortOrder;

    protected KeyImageRef() {
        // JPA 用
    }

    public KeyImageRef(String id, String sopInstanceUid, String seriesInstanceUid, Integer frameNumber,
            String label, String annotation, int sortOrder) {
        this.id = id;
        this.sopInstanceUid = sopInstanceUid;
        this.seriesInstanceUid = seriesInstanceUid;
        this.frameNumber = frameNumber;
        this.label = label;
        this.annotation = annotation;
        this.sortOrder = sortOrder;
    }

    public String getId() {
        return id;
    }

    public Report getReport() {
        return report;
    }

    public void setReport(Report report) {
        this.report = report;
    }

    public String getSopInstanceUid() {
        return sopInstanceUid;
    }

    public String getSeriesInstanceUid() {
        return seriesInstanceUid;
    }

    public Integer getFrameNumber() {
        return frameNumber;
    }

    public String getLabel() {
        return label;
    }

    public String getAnnotation() {
        return annotation;
    }

    public int getSortOrder() {
        return sortOrder;
    }
}
