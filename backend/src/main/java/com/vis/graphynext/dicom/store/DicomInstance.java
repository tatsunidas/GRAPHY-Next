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
        @Index(name = "ix_series", columnList = "seriesInstanceUid")
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
    private String studyInstanceUid;
    private String studyDate;
    private String studyDescription;

    // シリーズ
    private String seriesInstanceUid;
    private String modality;
    private Integer seriesNumber;
    private String seriesDescription;

    // インスタンス
    private Integer instanceNumber;

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

    public String getUri() {
        return uri;
    }

    public void setUri(String v) {
        this.uri = v;
    }
}
