/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code graphy.auth.*}（application-demo.yml + 環境変数）を束縛する設定。
 *
 * <p>{@code enabled}/{@code token-ttl-minutes}/{@code session-ttl-days} は application-demo.yml に
 * 既定値を持つが、{@code session-secret}/{@code internal-api-key}/{@code mailer-base-url}/
 * {@code turnstile-site-key}/{@code public-base-url} はシークレットのため yml には書かず、
 * Spring Boot の relaxed binding で docker-compose の environment（deploy/demo/.env 由来）から
 * 直接束縛させる（例: 環境変数 {@code GRAPHY_AUTH_SESSION_SECRET} → {@code session-secret}）。
 */
@ConfigurationProperties(prefix = "graphy.auth")
public class AuthProperties {

    /** マジックリンク認証ゲート（AuthFilter）を有効化するか。 */
    private boolean enabled = false;

    /** セッションCookieの署名に使うHMAC共有鍵。 */
    private String sessionSecret;

    /** mailer サイドカーへの内部API呼び出しに使う共有鍵（Authorization: Bearer）。 */
    private String internalApiKey;

    /** mailer サイドカーのベースURL（例: http://mailer:8081）。 */
    private String mailerBaseUrl;

    /** Cloudflare Turnstile のサイトキー（公開情報、ログイン画面に埋め込む）。 */
    private String turnstileSiteKey;

    /** マジックリンクの検証URLを組み立てる際の公開ベースURL（例: https://demo.vis-ionary.com）。 */
    private String publicBaseUrl;

    /**
     * graphy.vis-ionary.com（Xserver, subscribe.php）からの {@code POST /subscribe} 呼び出しを
     * 認証する共有鍵（Authorization: Bearer）。website側の更新通知登録フォームと、ここの
     * mailing_list_subscriber テーブルを一本化するために使う。
     */
    private String subscribeApiKey;

    /** マジックリンクトークンの有効期限（分）。 */
    private int tokenTtlMinutes = 15;

    /** ログインセッションの有効期限（日）。 */
    private int sessionTtlDays = 30;

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getSessionSecret() {
        return sessionSecret;
    }

    public void setSessionSecret(String sessionSecret) {
        this.sessionSecret = sessionSecret;
    }

    public String getInternalApiKey() {
        return internalApiKey;
    }

    public void setInternalApiKey(String internalApiKey) {
        this.internalApiKey = internalApiKey;
    }

    public String getMailerBaseUrl() {
        return mailerBaseUrl;
    }

    public void setMailerBaseUrl(String mailerBaseUrl) {
        this.mailerBaseUrl = mailerBaseUrl;
    }

    public String getTurnstileSiteKey() {
        return turnstileSiteKey;
    }

    public void setTurnstileSiteKey(String turnstileSiteKey) {
        this.turnstileSiteKey = turnstileSiteKey;
    }

    public String getPublicBaseUrl() {
        return publicBaseUrl;
    }

    public void setPublicBaseUrl(String publicBaseUrl) {
        this.publicBaseUrl = publicBaseUrl;
    }

    public String getSubscribeApiKey() {
        return subscribeApiKey;
    }

    public void setSubscribeApiKey(String subscribeApiKey) {
        this.subscribeApiKey = subscribeApiKey;
    }

    public int getTokenTtlMinutes() {
        return tokenTtlMinutes;
    }

    public void setTokenTtlMinutes(int tokenTtlMinutes) {
        this.tokenTtlMinutes = tokenTtlMinutes;
    }

    public int getSessionTtlDays() {
        return sessionTtlDays;
    }

    public void setSessionTtlDays(int sessionTtlDays) {
        this.sessionTtlDays = sessionTtlDays;
    }
}
