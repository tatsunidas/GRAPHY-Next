package com.vis.graphynext.dicom.store;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;

/**
 * ローカル索引の 1 インスタンス（DICOM SOP Instance）。
 *
 * <p>主キーは {@code sopInstanceUid}。これにより同一インスタンスの再受信は
 * upsert となり<b>冪等</b>になる（方針②）。ピクセル本体は DB に入れず、FS 上の
 * DICOM ファイルへの {@code file:} URI（方針④）だけを保持する。
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
    private String patientId;
    private String studyInstanceUid;
    private String seriesInstanceUid;

    @Column(length = 1024)
    private String uri;

    protected DicomInstance() {
        // JPA 用
    }

    public DicomInstance(String sopInstanceUid, String sopClassUid, String transferSyntaxUid,
                         String patientId, String studyInstanceUid, String seriesInstanceUid, String uri) {
        this.sopInstanceUid = sopInstanceUid;
        this.sopClassUid = sopClassUid;
        this.transferSyntaxUid = transferSyntaxUid;
        this.patientId = patientId;
        this.studyInstanceUid = studyInstanceUid;
        this.seriesInstanceUid = seriesInstanceUid;
        this.uri = uri;
    }

    public String getSopInstanceUid() {
        return sopInstanceUid;
    }

    public String getSopClassUid() {
        return sopClassUid;
    }

    public String getTransferSyntaxUid() {
        return transferSyntaxUid;
    }

    public String getPatientId() {
        return patientId;
    }

    public String getStudyInstanceUid() {
        return studyInstanceUid;
    }

    public String getSeriesInstanceUid() {
        return seriesInstanceUid;
    }

    public String getUri() {
        return uri;
    }
}
