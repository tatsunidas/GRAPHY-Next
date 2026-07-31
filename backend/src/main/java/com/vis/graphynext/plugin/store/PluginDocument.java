/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.store;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

import java.time.Instant;

/**
 * プラグイン 1 つ × 患者 1 人分の保存領域（プラグイン host API の H8）。
 *
 * <p><b>なぜ本体が持つのか</b>: プラグインが自前で持てる保存先は `localStorage`（端末ローカル）
 * しかない。時系列の評価（RECIST 等）は**数か月〜数年**にわたる記録なので、端末に閉じると
 * 別の PC で開いた読影医には過去の回が見えず、判定（nadir・BOR）が静かに変わる。
 *
 * <p><b>中身は解釈しない</b>。スキーマの正本はプラグイン側にある。本体がやるのは
 * ①プラグイン×患者単位の保管 ②楽観ロックによる上書き事故の防止 ③壊れた入力・巨大な入力の拒否。
 *
 * <p>ROI 永続化（{@code roi_document}）と**別のテーブル**にしてある。ROI は本体の機能で
 * 標準形式へ書き出す対象だが、こちらはプラグイン固有の内容で、本体からは意味が分からない。
 * 混ぜると「ROI を消す」操作でプラグインの記録まで消えるといった巻き添えが起きる。
 */
@Entity
@Table(name = "plugin_document")
public class PluginDocument {

    @EmbeddedId
    private PluginDocumentId id;

    /** プラグインが保存した JSON（スキーマはプラグイン側が正本）。 */
    @Lob
    @Column(nullable = false)
    private String json;

    @Column(nullable = false)
    private Instant updatedAt;

    /**
     * 楽観ロック。同じ患者を複数のウィンドウ（あるいは複数の端末）で開けるため、
     * **後から来た保存が黙って前の保存を消す**のを防ぐ（衝突時は 409。呼び出し側が
     * 読み直してから統合して再保存する）。
     */
    @Version
    private Long version;

    protected PluginDocument() {
        // JPA 用
    }

    public PluginDocument(String pluginId, String patientKey, String json) {
        this.id = new PluginDocumentId(pluginId, patientKey);
        this.json = json;
        this.updatedAt = Instant.now();
    }

    public PluginDocumentId getId() {
        return id;
    }

    public String getJson() {
        return json;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public Long getVersion() {
        return version;
    }

    public void update(String json) {
        this.json = json;
        this.updatedAt = Instant.now();
    }
}
