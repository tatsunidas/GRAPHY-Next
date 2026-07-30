/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

import java.time.Instant;

/**
 * 患者 1 人分の ROI（幾何注釈）の保存単位（`fw/roi-manager-design.md` の M5・アプリ内 JSON）。
 *
 * <p><b>なぜ患者単位か</b>: 時系列で同じ病変を追う用途（RECIST 1.1 等）では、ベースラインと
 * 複数の追跡スタディにまたがって ROI を突き合わせる。スタディ単位に割ると、プラグインが
 * 患者の全 ROI を得るのに何回も問い合わせる必要があり、「同じ病変か」の判断材料が分断される。
 *
 * <p><b>なぜ JSON 1 本か</b>: ROI の実体は Cornerstone annotation（ハンドル座標＋メタ）で、
 * 形は tool 種別ごとに違う。列に開くと tool を増やすたびにスキーマ移行が必要になる。
 * ここでの目的は「同じ UID で往復できること」なので、フロントの表現をそのまま JSON で持つ。
 * 標準形式（DICOM RTSTRUCT / SR / ImageJ ROI）への書き出しは別機能として既存のまま残る。
 *
 * <p><b>マスク（labelmap）は対象外</b>。マスクは DICOM SEG の往復が既に実装済みで、
 * 画素データを JSON に入れるのは筋が悪い。
 */
@Entity
@Table(name = "roi_document")
public class RoiDocument {

    /**
     * 患者判定キー（フロントの {@code patientKey} ＝ PatientID → 無ければ PatientName →
     * 無ければ StudyInstanceUID）。フロント側の同一患者判定と同じ値をそのまま鍵にする。
     */
    @Id
    @Column(length = 256)
    private String patientKey;

    /** ROI の配列を含む JSON（スキーマはフロントの `roiPersistence.ts` が正本）。 */
    @Lob
    @Column(nullable = false)
    private String json;

    /** 保存されている ROI 件数（一覧表示・件数確認を JSON パースなしで行うため）。 */
    @Column(nullable = false)
    private int roiCount;

    @Column(nullable = false)
    private Instant updatedAt;

    /**
     * 楽観ロック。2D Viewer は患者ごとに複数ウィンドウを開けるため、同じ患者の ROI を
     * 別ウィンドウが同時に保存し得る。**後から来た方が黙って前の保存を消す**のを防ぐ
     * （衝突時は 409 を返し、フロントが読み直してから再保存する）。
     */
    @Version
    private Long version;

    protected RoiDocument() {
        // JPA 用
    }

    public RoiDocument(String patientKey, String json, int roiCount) {
        this.patientKey = patientKey;
        this.json = json;
        this.roiCount = roiCount;
        this.updatedAt = Instant.now();
    }

    public String getPatientKey() {
        return patientKey;
    }

    public String getJson() {
        return json;
    }

    public int getRoiCount() {
        return roiCount;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public Long getVersion() {
        return version;
    }

    public void update(String json, int roiCount) {
        this.json = json;
        this.roiCount = roiCount;
        this.updatedAt = Instant.now();
    }
}
