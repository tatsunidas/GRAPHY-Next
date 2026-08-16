/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * 保存された GLAM 解析。
 *
 * <p><b>保存は任意</b>。解析は開くたびに計算し直せる（ROI が同じなら同じ数値になる）ので、
 * 常に残す必要は無い。残すのは「この ROI のこの設定での結果を、後でまた見たい」と利用者が
 * 判断したときだけで、その判断を UI の保存ボタンに任せている。
 *
 * <p><b>なぜ JSON 1 本か</b>: 中身は動径分布関数（nBins×nBins×maxRadius）と 19 個の行列で、
 * 列に開くと nBins や maxRadius を変えるたびにスキーマ移行が要る。ここでの目的は
 * 「保存したときの数値をそのまま復元できること」なので、返した形をそのまま持つ。
 *
 * <p>スタディ単位で引けるように {@code studyInstanceUid} に索引を張る（一覧は study 内で出す）。
 */
@Entity
@Table(name = "glam_analysis")
public class GlamAnalysisDocument {

    /** 保存 ID（UUID）。 */
    @Id
    @Column(length = 64)
    private String id;

    @Column(nullable = false, length = 128)
    private String studyInstanceUid;

    /** 解析対象シリーズ。 */
    @Column(nullable = false, length = 128)
    private String sourceSeriesUid;

    /** ROI マスクシリーズ。 */
    @Column(length = 128)
    private String maskSeriesUid;

    /** 利用者がつけた名前（未指定なら UI 側で日時から作る）。 */
    @Column(nullable = false, length = 256)
    private String label;

    /** {@link GlamAnalysis} をそのまま JSON にしたもの。 */
    @Lob
    @Column(nullable = false)
    private String json;

    /** 一覧で JSON を開かずに要点を出すための控え。 */
    @Column(nullable = false)
    private int nBins;

    @Column(nullable = false)
    private int maxRadius;

    @Column(nullable = false)
    private long roiVoxelCount;

    @Column(nullable = false)
    private Instant savedAt;

    protected GlamAnalysisDocument() {
        // JPA 用
    }

    public GlamAnalysisDocument(String id, String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                                String label, String json, int nBins, int maxRadius, long roiVoxelCount) {
        this.id = id;
        this.studyInstanceUid = studyInstanceUid;
        this.sourceSeriesUid = sourceSeriesUid;
        this.maskSeriesUid = maskSeriesUid;
        this.label = label;
        this.json = json;
        this.nBins = nBins;
        this.maxRadius = maxRadius;
        this.roiVoxelCount = roiVoxelCount;
        this.savedAt = Instant.now();
    }

    public String getId() {
        return id;
    }

    public String getStudyInstanceUid() {
        return studyInstanceUid;
    }

    public String getSourceSeriesUid() {
        return sourceSeriesUid;
    }

    public String getMaskSeriesUid() {
        return maskSeriesUid;
    }

    public String getLabel() {
        return label;
    }

    public String getJson() {
        return json;
    }

    public int getNBins() {
        return nBins;
    }

    public int getMaxRadius() {
        return maxRadius;
    }

    public long getRoiVoxelCount() {
        return roiVoxelCount;
    }

    public Instant getSavedAt() {
        return savedAt;
    }
}
