/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code graphy.share.*}（application-share.yml + 環境変数）を束縛する設定。
 *
 * <p>共有サービス（検査単位の期限つき閲覧リンク）を有効にするか、と、その鍵・期限・失敗の制限。
 * {@code admin-key}・{@code session-secret} は秘密なので yml には書かず、環境変数
 * （{@code GRAPHY_SHARE_ADMIN_KEY}・{@code GRAPHY_SHARE_SESSION_SECRET}）から束縛する。
 */
@ConfigurationProperties(prefix = "graphy.share")
public class ShareProperties {

    static final int MIN_SECRET_LENGTH = 32;

    private boolean enabled = false;
    /** 発行・一覧・取り消しの管理 API を認証する共有鍵（Authorization: Bearer）。 */
    private String adminKey;
    /** 閲覧セッション Cookie の署名に使う HMAC 鍵。 */
    private String sessionSecret;
    /** 発行時に期限を指定しなかったときの有効日数。 */
    private int defaultTtlDays = 7;
    /** 有効日数の上限。これを超える指定は切り詰める。 */
    private int maxTtlDays = 30;
    /** 閲覧セッション（Cookie）の最長時間。リンクの残り期限のほうが短ければそちらに合わせる。 */
    private int sessionMaxHours = 12;
    /** 1 IP あたり 1 分間に許す、入口・管理 API の失敗回数。超えたら 429。 */
    private int failuresPerMinute = 10;
    /** 発行の応答に入れるリンクの公開ベース URL（例: https://share.example.com）。未設定ならパスだけ返す。 */
    private String publicBaseUrl;

    /** 有効なのに鍵が無い・短い状態で起動させない（フェイルクローズ）。 */
    void validate() {
        if (!enabled) {
            return;
        }
        if (adminKey == null || adminKey.length() < MIN_SECRET_LENGTH) {
            throw new IllegalStateException("graphy.share.admin-key は " + MIN_SECRET_LENGTH + " 文字以上が必要です");
        }
        if (sessionSecret == null || sessionSecret.length() < MIN_SECRET_LENGTH) {
            throw new IllegalStateException("graphy.share.session-secret は " + MIN_SECRET_LENGTH + " 文字以上が必要です");
        }
        if (defaultTtlDays < 1 || maxTtlDays < defaultTtlDays || sessionMaxHours < 1 || failuresPerMinute < 1) {
            throw new IllegalStateException("graphy.share の期限・制限の値が不正です");
        }
    }

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public String getAdminKey() { return adminKey; }
    public void setAdminKey(String adminKey) { this.adminKey = adminKey; }
    public String getSessionSecret() { return sessionSecret; }
    public void setSessionSecret(String sessionSecret) { this.sessionSecret = sessionSecret; }
    public int getDefaultTtlDays() { return defaultTtlDays; }
    public void setDefaultTtlDays(int defaultTtlDays) { this.defaultTtlDays = defaultTtlDays; }
    public int getMaxTtlDays() { return maxTtlDays; }
    public void setMaxTtlDays(int maxTtlDays) { this.maxTtlDays = maxTtlDays; }
    public int getSessionMaxHours() { return sessionMaxHours; }
    public void setSessionMaxHours(int sessionMaxHours) { this.sessionMaxHours = sessionMaxHours; }
    public int getFailuresPerMinute() { return failuresPerMinute; }
    public void setFailuresPerMinute(int failuresPerMinute) { this.failuresPerMinute = failuresPerMinute; }
    public String getPublicBaseUrl() { return publicBaseUrl; }
    public void setPublicBaseUrl(String publicBaseUrl) { this.publicBaseUrl = publicBaseUrl; }
}
