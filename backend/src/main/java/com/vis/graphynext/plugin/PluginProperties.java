/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code graphy.plugins.*}（application.yml）を束縛するプラグイン設定。
 *
 * <p>standalone では Electron が書込可能な場所（例 {@code ~/.graphy-next/plugins}）を
 * {@code graphy.plugins.dir} で渡す。web では運営が配備したフォルダを指す。
 */
@ConfigurationProperties(prefix = "graphy.plugins")
public class PluginProperties {

    /** プラグイン機構を有効にするか。 */
    private boolean enabled = true;

    /** プラグイン格納フォルダ（各サブフォルダが 1 プラグイン、直下に plugin.json）。 */
    private String dir = "./plugins";

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getDir() {
        return dir;
    }

    public void setDir(String dir) {
        this.dir = dir;
    }
}
