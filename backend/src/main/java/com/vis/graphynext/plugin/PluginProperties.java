/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

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
     * プラグインマネージャ（取得・導入・更新・削除）を<b>この環境で許すか</b>という管理者ゲート。
     * 既定 true。false にすると環境設定のオプトイン トグルごと封じられ、閲覧のみになる
     * （施設が一律に禁止したい場合に使う）。
     *
     * <p>true でも実際の導入操作にはユーザーの明示的オプトイン
     * （設定キー {@code plugins.installEnabled}）が別途要る。standalone 以外では常に不可
     * （web は共有サーバーのため運営キュレーション前提）。設計: fw/plugin-manager-design.md §5。
     */
    private boolean managerEnabled = true;

    /**
     * private リポジトリの列挙・資産取得に使う GitHub トークン（任意・PAT）。
     * 未設定なら公開リポジトリのみ。OAuth device flow は将来（P2）。
     */
    private String githubToken;

    /** 公式キュレーション索引の URL（raw JSON）。将来の discovery 用（任意）。 */
    private String indexUrl;

    /**
     * 信頼する minisign 公開鍵（base64 blob もしくは公開鍵ファイルの中身）。
     *
     * <p>ここに載る鍵で署名が検証できたプラグインは {@code verified} 扱いになり、
     * 導入時の同意画面を出さずにそのまま入る（＝公式配布の操作性を従来どおりにする）。
     * ユーザーが鍵を扱う場面は無い。設計: fw/plugin-manager-design.md §5.2。
     */
    private List<String> trustedKeys = new ArrayList<>();

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

    public List<String> getTrustedKeys() {
        return trustedKeys;
    }

    public void setTrustedKeys(List<String> trustedKeys) {
        this.trustedKeys = trustedKeys == null ? new ArrayList<>() : trustedKeys;
    }
}
