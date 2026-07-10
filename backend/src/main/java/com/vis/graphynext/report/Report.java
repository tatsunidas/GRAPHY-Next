/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Lob;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * レポート（Markdown 執筆 → 確定時に DICOM-SR/KO 化、フェーズ2）の集約ルート。
 *
 * <p>{@code status=DRAFT} の間のみ本文・参加者・キー画像を編集できる。確定後（FINAL/ADDENDUM）は
 * {@code srSopInstanceUid}/{@code koSopInstanceUid} が埋まり編集不可になる（確定処理自体はフェーズ2 {@code SrWriter}）。
 */
@Entity
@Table(name = "report", indexes = {
        @Index(name = "ix_report_patient", columnList = "patientId"),
        @Index(name = "ix_report_study", columnList = "studyInstanceUid"),
        @Index(name = "ix_report_status", columnList = "status")
})
public class Report {

    @Id
    @Column(length = 36)
    private String id;

    @Column(nullable = false, length = 64)
    private String patientId;

    @Column(nullable = false, length = 64)
    private String studyInstanceUid;

    /** SR 生成時に発番するシリーズ UID（フェーズ2）。下書きの間は null。 */
    private String seriesInstanceUid;

    @Column(length = 500)
    private String title;

    @Enumerated(EnumType.STRING)
    private ReportType reportType;

    @Enumerated(EnumType.STRING)
    private ReportStatus status;

    @Lob
    private String bodyMarkdown;

    @Lob
    private String clinicalHistory;

    private String referringPhysician;

    private String srSopInstanceUid;
    private String koSopInstanceUid;
    private String koSeriesInstanceUid;

    /** 追記（addendum）チェーン。UI はフェーズ1では未対応、モデルのみ保持。 */
    private String predecessorReportId;
    private String predecessorSrSopUid;

    private String lockedBy;
    private Instant lockedAt;

    private Instant createdAt;
    private Instant updatedAt;

    @OneToMany(mappedBy = "report", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("participatedAt asc")
    private List<ReportParticipant> participants = new ArrayList<>();

    @OneToMany(mappedBy = "report", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("sortOrder asc")
    private List<KeyImageRef> keyImages = new ArrayList<>();

    protected Report() {
        // JPA 用
    }

    public Report(String id) {
        this.id = id;
    }

    public String getId() {
        return id;
    }

    public String getPatientId() {
        return patientId;
    }

    public void setPatientId(String patientId) {
        this.patientId = patientId;
    }

    public String getStudyInstanceUid() {
        return studyInstanceUid;
    }

    public void setStudyInstanceUid(String studyInstanceUid) {
        this.studyInstanceUid = studyInstanceUid;
    }

    public String getSeriesInstanceUid() {
        return seriesInstanceUid;
    }

    public void setSeriesInstanceUid(String seriesInstanceUid) {
        this.seriesInstanceUid = seriesInstanceUid;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public ReportType getReportType() {
        return reportType;
    }

    public void setReportType(ReportType reportType) {
        this.reportType = reportType;
    }

    public ReportStatus getStatus() {
        return status;
    }

    public void setStatus(ReportStatus status) {
        this.status = status;
    }

    public String getBodyMarkdown() {
        return bodyMarkdown;
    }

    public void setBodyMarkdown(String bodyMarkdown) {
        this.bodyMarkdown = bodyMarkdown;
    }

    public String getClinicalHistory() {
        return clinicalHistory;
    }

    public void setClinicalHistory(String clinicalHistory) {
        this.clinicalHistory = clinicalHistory;
    }

    public String getReferringPhysician() {
        return referringPhysician;
    }

    public void setReferringPhysician(String referringPhysician) {
        this.referringPhysician = referringPhysician;
    }

    public String getSrSopInstanceUid() {
        return srSopInstanceUid;
    }

    public void setSrSopInstanceUid(String srSopInstanceUid) {
        this.srSopInstanceUid = srSopInstanceUid;
    }

    public String getKoSopInstanceUid() {
        return koSopInstanceUid;
    }

    public void setKoSopInstanceUid(String koSopInstanceUid) {
        this.koSopInstanceUid = koSopInstanceUid;
    }

    public String getKoSeriesInstanceUid() {
        return koSeriesInstanceUid;
    }

    public void setKoSeriesInstanceUid(String koSeriesInstanceUid) {
        this.koSeriesInstanceUid = koSeriesInstanceUid;
    }

    public String getPredecessorReportId() {
        return predecessorReportId;
    }

    public void setPredecessorReportId(String predecessorReportId) {
        this.predecessorReportId = predecessorReportId;
    }

    public String getPredecessorSrSopUid() {
        return predecessorSrSopUid;
    }

    public void setPredecessorSrSopUid(String predecessorSrSopUid) {
        this.predecessorSrSopUid = predecessorSrSopUid;
    }

    public String getLockedBy() {
        return lockedBy;
    }

    public void setLockedBy(String lockedBy) {
        this.lockedBy = lockedBy;
    }

    public Instant getLockedAt() {
        return lockedAt;
    }

    public void setLockedAt(Instant lockedAt) {
        this.lockedAt = lockedAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Instant updatedAt) {
        this.updatedAt = updatedAt;
    }

    public List<ReportParticipant> getParticipants() {
        return participants;
    }

    public List<KeyImageRef> getKeyImages() {
        return keyImages;
    }

    public void addParticipant(ReportParticipant participant) {
        participant.setReport(this);
        participants.add(participant);
    }

    /** 参加者を全置換する更新（PUT）のために既存分を外す。 */
    public void clearParticipants() {
        participants.clear();
    }

    public void addKeyImage(KeyImageRef keyImage) {
        keyImage.setReport(this);
        keyImages.add(keyImage);
    }

    /** キー画像を全置換する更新（PUT）のために既存分を外す。 */
    public void clearKeyImages() {
        keyImages.clear();
    }
}
