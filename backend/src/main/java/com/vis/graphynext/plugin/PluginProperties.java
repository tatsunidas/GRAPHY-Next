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

    /**
     * プラグインマネージャ（取得・導入・更新・削除）の有効化。既定 false＝閲覧のみ。
     * standalone でのみ実際の導入操作を許す（web は共有サーバーのため運営キュレーション前提）。
     */
    private boolean managerEnabled = false;

    /**
     * private リポジトリの列挙・資産取得に使う GitHub トークン（任意・PAT）。
     * 未設定なら公開リポジトリのみ。OAuth device flow は将来（P2）。
     */
    private String githubToken;

    /** 公式キュレーション索引の URL（raw JSON）。将来の discovery 用（任意）。 */
    private String indexUrl;

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

    public boolean isManagerEnabled() {
        return managerEnabled;
    }

    public void setManagerEnabled(boolean managerEnabled) {
        this.managerEnabled = managerEnabled;
    }

    public String getGithubToken() {
        return githubToken;
    }

    public void setGithubToken(String githubToken) {
        this.githubToken = githubToken;
    }

    public String getIndexUrl() {
        return indexUrl;
    }

    public void setIndexUrl(String indexUrl) {
        this.indexUrl = indexUrl;
    }
}
