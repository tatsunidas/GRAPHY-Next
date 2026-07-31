/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.store;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

import java.io.Serializable;
import java.util.Objects;

/**
 * プラグイン保存領域の鍵（プラグイン id ＋ 患者判定キー）。
 *
 * <p><b>プラグイン id を鍵に含める</b>のが要点。プラグインごとに領域を分けておかないと、
 * 別のプラグインの保存を上書きし得る（RECIST の数か月分の記録が、無関係なプラグインの
 * 保存で消える、という事故になる）。
 */
@Embeddable
public class PluginDocumentId implements Serializable {

    private static final long serialVersionUID = 1L;

    @Column(name = "plugin_id", length = 64, nullable = false)
    private String pluginId;

    @Column(name = "patient_key", length = 256, nullable = false)
    private String patientKey;

    protected PluginDocumentId() {
        // JPA 用
    }

    public PluginDocumentId(String pluginId, String patientKey) {
        this.pluginId = pluginId;
        this.patientKey = patientKey;
    }

    public String getPluginId() {
        return pluginId;
    }

    public String getPatientKey() {
        return patientKey;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof PluginDocumentId other)) {
            return false;
        }
        return Objects.equals(pluginId, other.pluginId) && Objects.equals(patientKey, other.patientKey);
    }

    @Override
    public int hashCode() {
        return Objects.hash(pluginId, patientKey);
    }
}
