/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.vis.graphynext.settings.SettingsService;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * プラグイン導入の同意を変える口。{@code /api/internal/**} なので {@code MainChannelFilter} が
 * Electron main だけに開く（起動ごとの秘密・ループバック・Origin 無し）。main は有効にする前に
 * ネイティブの確認ダイアログを出す（レンダラ・プラグインからは迂回できない）。
 */
@RestController
@RequestMapping("/api/internal/plugin-manager")
@Profile("standalone")
public class PluginOptInInternalController {

    private final SettingsService settings;

    public PluginOptInInternalController(SettingsService settings) {
        this.settings = settings;
    }

    public record OptInRequest(boolean enabled) {
    }

    @PutMapping("/opt-in")
    public Map<String, Boolean> setOptIn(@RequestBody OptInRequest req) {
        settings.putAll(Map.of(SettingsService.PLUGIN_INSTALL_ENABLED_KEY, String.valueOf(req.enabled())));
        return Map.of("installEnabled", req.enabled());
    }
}
