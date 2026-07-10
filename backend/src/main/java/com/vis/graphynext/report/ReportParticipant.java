/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * レポート 1 件の参加者 1 名（{@link StaffRole} × {@link ParticipationType} のペア）。
 * 認証は無く、名前は自由入力（フェーズ2でスタッフディレクトリと連携する余地を残す）。
 */
@Entity
@Table(name = "report_participant", indexes = {
        @Index(name = "ix_participant_report", columnList = "report_id")
})
public class ReportParticipant {

    @Id
    @Column(length = 36)
    private String id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "report_id", nullable = false)
    private Report report;

    private String name;

    @Enumerated(EnumType.STRING)
    private StaffRole staffRole;

    @Enumerated(EnumType.STRING)
    private ParticipationType participationType;

    private String organization;

    private Instant participatedAt;

    protected ReportParticipant() {
        // JPA 用
    }

    public ReportParticipant(String id, String name, StaffRole staffRole, ParticipationType participationType,
            String organization) {
        this.id = id;
        this.name = name;
        this.staffRole = staffRole;
        this.participationType = participationType;
        this.organization = organization;
        this.participatedAt = Instant.now();
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

    public String getName() {
        return name;
    }

    public StaffRole getStaffRole() {
        return staffRole;
    }

    public ParticipationType getParticipationType() {
        return participationType;
    }

    public String getOrganization() {
        return organization;
    }

    public Instant getParticipatedAt() {
        return participatedAt;
    }
}
