/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.microscopy;

import com.vis.graphynext.settings.SettingsService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.UUID;

/**
 * 変換した本体を「装置」として DICOM に書くときの識別（fw/microscopy-cfm.md）。シリアル番号は、インストールごとに 1 度だけ作る
 * UUID を設定（DB フォルダの外の共通の設定）に保存して使う（2026-10-17 ユーザー決定）。
 */
@Component
public class InstallationIdentity {

    static final String KEY = "system.installationId";
    public static final String MANUFACTURER = "Visionary Imaging Services, Inc.";
    public static final String MODEL = "GRAPHY-Next";

    private final SettingsService settings;
    private final String version;

    public InstallationIdentity(SettingsService settings, @Value("${graphy.version:dev}") String version) {
        this.settings = settings;
        this.version = version;
    }

    public synchronized String installationId() {
        String id = settings.getAll().get(KEY);
        if (id == null || id.isBlank()) {
            id = UUID.randomUUID().toString();
            settings.putAll(Map.of(KEY, id));
        }
        return id;
    }

    public ConfocalMicroscopyWriter.Equipment equipment() {
        return new ConfocalMicroscopyWriter.Equipment(MANUFACTURER, MODEL, installationId(), version);
    }
}
