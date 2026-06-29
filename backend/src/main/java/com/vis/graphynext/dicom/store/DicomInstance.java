/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;

/**
 * ローカル索引の 1 インスタンス（DICOM SOP Instance）。
 *
 * <p>主キーは {@code sopInstanceUid}（再受信は upsert で冪等）。ピクセル本体は FS に置き、
 * ここには {@code file:} URI と、スタディ/シリーズ ナビゲーション表示に必要な属性を保持する。
 */
@Entity
@Table(name = "dicom_instance", indexes = {
        @Index(name = "ix_patient", columnList = "patientId"),
        @Index(name = "ix_study", columnList = "studyInstanceUid"),
        @Index(name = "ix_series", columnList = "seriesInstanceUid"),
        // 統計集計用（モダリティ別・時系列）
        @Index(name = "ix_modality", columnList = "modality"),
        @Index(name = "ix_studydate", columnList = "studyDate")
})
public class DicomInstance {

    @Id
    @Column(length = 255)
    private String sopInstanceUid;

    private String sopClassUid;
    private String transferSyntaxUid;

    // 患者 / スタディ
    private String patientId;
    private String patientName;
    private String patientBirthDate;
    private String patientSex;
    private String studyInstanceUid;
    private String studyDate;
    private String studyDescription;
    private String accessionNumber;

    // シリーズ
    private String seriesInstanceUid;
    private String modality;
    private Integer seriesNumber;
    private String seriesDescription;

    // インスタンス
    private Integer instanceNumber;

    /** 保存した DICOM ファイルのバイトサイズ（容量統計用）。 */
    private Long sizeBytes;

    @Column(length = 1024)
    private String uri;

    protected DicomInstance() {
        // JPA 用
    }

    public DicomInstance(String sopInstanceUid) {
        this.sopInstanceUid = sopInstanceUid;
    }

    public String getSopInstanceUid() {
        return sopInstanceUid;
    }

    public String getSopClassUid() {
        return sopClassUid;
    }

    public void setSopClassUid(String v) {
        this.sopClassUid = v;
    }

    public String getTransferSyntaxUid() {
        return transferSyntaxUid;
    }

    public void setTransferSyntaxUid(String v) {
        this.transferSyntaxUid = v;
    }

    public String getPatientId() {
        return patientId;
    }

    public void setPatientId(String v) {
        this.patientId = v;
    }

    public String getPatientName() {
        return patientName;
    }

    public void setPatientName(String v) {
        this.patientName = v;
    }

    public String getPatientBirthDate() {
        return patientBirthDate;
    }

    public void setPatientBirthDate(String v) {
        this.patientBirthDate = v;
    }

    public String getPatientSex() {
        return patientSex;
    }

    public void setPatientSex(String v) {
        this.patientSex = v;
    }

    public String getStudyInstanceUid() {
        return studyInstanceUid;
    }

    public void setStudyInstanceUid(String v) {
        this.studyInstanceUid = v;
    }

    public String getStudyDate() {
        return studyDate;
    }

    public void setStudyDate(String v) {
        this.studyDate = v;
    }

    public String getStudyDescription() {
        return studyDescription;
    }

    public void setStudyDescription(String v) {
        this.studyDescription = v;
    }

    public String getAccessionNumber() {
        return accessionNumber;
    }

    public void setAccessionNumber(String v) {
        this.accessionNumber = v;
    }

    public String getSeriesInstanceUid() {
        return seriesInstanceUid;
    }

    public void setSeriesInstanceUid(String v) {
        this.seriesInstanceUid = v;
    }

    public String getModality() {
        return modality;
    }

    public void setModality(String v) {
        this.modality = v;
    }

    public Integer getSeriesNumber() {
        return seriesNumber;
    }

    public void setSeriesNumber(Integer v) {
        this.seriesNumber = v;
    }

    public String getSeriesDescription() {
        return seriesDescription;
    }

    public void setSeriesDescription(String v) {
        this.seriesDescription = v;
    }

    public Integer getInstanceNumber() {
        return instanceNumber;
    }

    public void setInstanceNumber(Integer v) {
        this.instanceNumber = v;
    }

    public Long getSizeBytes() {
        return sizeBytes;
    }

    public void setSizeBytes(Long v) {
        this.sizeBytes = v;
    }

    public String getUri() {
        return uri;
    }

    public void setUri(String v) {
        this.uri = v;
    }
}
