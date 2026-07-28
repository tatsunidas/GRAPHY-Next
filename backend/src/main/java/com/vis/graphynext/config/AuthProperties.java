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

    /**
     * お知らせメール登録者だけを保管する専用DBのJDBC URL。
     *
     * <p>アプリ本体のH2（{@code ./data/graphy-index}）とは意図的に別ファイル・別ボリュームにする。
     * 公開デモは毎晩 {@code deploy/demo/reset-demo.sh} が {@code /app/data} をゴールデンスナップショットへ
     * 丸ごと戻すため、同居させると日中の登録が毎晩消えてしまう（実際に消えていた）。リセットが触らない
     * 場所へ物理的に分けることで、リセット手順の書き方に依存せず登録者が守られる。
     *
     * <p>{@code AUTO_SERVER=TRUE} は {@code deploy/demo/export-subscribers.sh} が
     * アプリを止めずに別プロセスから読み出すために必要。
     */
    private String subscriberDbUrl = "jdbc:h2:file:./subscribers/graphy-subscribers;AUTO_SERVER=TRUE";

    /**
     * {@code POST /admin/announce}（更新通知の一斉配信）を認証する共有鍵。
     *
     * <p>{@code subscribe-api-key} とは別にする。あちらは「1件足すだけ」だが、こちらは
     * 登録者全員へメールを送れてしまう。権限の大きさが違うものを同じ鍵で守ると、
     * 片方が漏れたときの被害範囲が跳ね上がる。
     *
     * <p>未設定（null/空）の場合、配信エンドポイントは常に 401 を返す（＝機能が無効）。
     */
    private String announceApiKey;

    /**
     * 更新通知の送信レート（通/分）。SMTP 側の送信上限に合わせて調整する。
     * 上限を超えると一時的な拒否や、送信ドメインの評判低下につながるため、控えめな既定値にしてある。
     * 0以下を指定すると間隔を空けない（テスト用。実環境では設定しないこと）。
     */
    private int announceRatePerMinute = 30;

    /** 製品サイトの公開URL。更新通知メール本文のダウンロード導線に使う。 */
    private String siteBaseUrl = "https://graphy.vis-ionary.com";

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

    public String getSubscriberDbUrl() {
        return subscriberDbUrl;
    }

    public void setSubscriberDbUrl(String subscriberDbUrl) {
        this.subscriberDbUrl = subscriberDbUrl;
    }

    public String getAnnounceApiKey() {
        return announceApiKey;
    }

    public void setAnnounceApiKey(String announceApiKey) {
        this.announceApiKey = announceApiKey;
    }

    public int getAnnounceRatePerMinute() {
        return announceRatePerMinute;
    }

    public void setAnnounceRatePerMinute(int announceRatePerMinute) {
        this.announceRatePerMinute = announceRatePerMinute;
    }

    public String getSiteBaseUrl() {
        return siteBaseUrl;
    }

    public void setSiteBaseUrl(String siteBaseUrl) {
        this.siteBaseUrl = siteBaseUrl;
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
