/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.vis.graphynext.settings.SettingsService;
import org.springframework.stereotype.Component;

/**
 * 導入オプトインを設定ストア（{@code /api/settings} の
 * {@code plugins.installEnabled}）から読む既定実装。未設定なら false（＝閲覧のみ）。
 *
 * <p>書き込みはフロントの環境設定が {@code PUT /api/settings} で行う（専用 API を増やさない）。
 */
@Component
public class SettingsInstallOptIn implements InstallOptIn {

    private final SettingsService settings;

    public SettingsInstallOptIn(SettingsService settings) {
        this.settings = settings;
    }

    @Override
    public boolean isEnabled() {
        return Boolean.parseBoolean(settings.getAll().get(SettingsService.PLUGIN_INSTALL_ENABLED_KEY));
    }
}
