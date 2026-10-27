/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

import java.time.Instant;

/**
 * 塗り ROI（マスク）1 件の保存単位。
 *
 * <p><b>なぜ {@link RoiDocument} と別のテーブルか</b>: 形の ROI は座標だけで小さく、患者 1 行の JSON に
 * 収まる。マスクは画素（スライスごとの 0/1 面）で、JSON に混ぜると 1 行が肥大し、
 * 形の ROI を保存するたびに全マスクを書き直すことになる。マスクは 1 件ごとに 1 行にして、
 * 変更があったものだけを書く。
 *
 * <p>backend は中身を解釈しない（スキーマの正本はフロントの {@code maskPersistence.ts}）。
 * {@code meta} は JSON 文字列、{@code frames} はフロントが deflate した不透明なバイト列。
 */
@Entity
@Table(name = "roi_mask_document", indexes = {
        @Index(name = "idx_roi_mask_patient", columnList = "patientKey"),
        @Index(name = "idx_roi_mask_series", columnList = "seriesUid")
})
public class RoiMaskDocument {

    /** フロントが採番する安定 ID（UUID）。セッション固有のマスク ID とは別。 */
    @Id
    @Column(length = 64)
    private String maskUid;

    /** 患者判定キー（{@link RoiDocument} と同じ）。 */
    @Column(nullable = false, length = 256)
    private String patientKey;

    /** マスクが載っているシリーズ（復元時の絞り込み用。一覧で画素を読まずに引けるよう列にする）。 */
    @Column(nullable = false, length = 128)
    private String seriesUid;

    /** 名前・グループ・範囲・セグメント名などの JSON。 */
    @Lob
    @Column(nullable = false)
    private String meta;

    /** 画素（フロントが圧縮したバイト列）。 */
    @Lob
    @Column(nullable = false)
    private byte[] frames;

    /** 前景を持つスライス枚数（フロントが数える。一覧表示用）。 */
    @Column(nullable = false)
    private int frameCount;

    /**
     * {@code frames} のバイト数。一覧で画素を読まずに大きさを返すため列に持つ
     * （JPQL の {@code length()} はバイナリの @Lob に使えない）。
     */
    @Column(nullable = false)
    private int frameBytes;

    @Column(nullable = false)
    private Instant updatedAt;

    /** 楽観ロック（別ウィンドウの上書き事故を 409 で止める）。 */
    @Version
    private Long version;

    protected RoiMaskDocument() {
        // JPA 用
    }

    public RoiMaskDocument(String maskUid, String patientKey, String seriesUid, String meta, byte[] frames, int frameCount) {
        this.maskUid = maskUid;
        this.patientKey = patientKey;
        this.seriesUid = seriesUid;
        this.meta = meta;
        this.frames = frames;
        this.frameCount = frameCount;
        this.frameBytes = frames.length;
        this.updatedAt = Instant.now();
    }

    public void update(String seriesUid, String meta, byte[] frames, int frameCount) {
        this.seriesUid = seriesUid;
        this.meta = meta;
        this.frames = frames;
        this.frameCount = frameCount;
        this.frameBytes = frames.length;
        this.updatedAt = Instant.now();
    }

    /** 患者キーが変わったとき（患者 ID の編集など）に、行とメタの患者キーを新しい値へ付け替える。画素・シリーズは変えない。 */
    public void moveTo(String patientKey, String meta) {
        this.patientKey = patientKey;
        this.meta = meta;
        this.updatedAt = Instant.now();
    }

    public String getMaskUid() {
        return maskUid;
    }

    public String getPatientKey() {
        return patientKey;
    }

    public String getSeriesUid() {
        return seriesUid;
    }

    public String getMeta() {
        return meta;
    }

    public byte[] getFrames() {
        return frames;
    }

    public int getFrameCount() {
        return frameCount;
    }

    public int getFrameBytes() {
        return frameBytes;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public Long getVersion() {
        return version;
    }
}
