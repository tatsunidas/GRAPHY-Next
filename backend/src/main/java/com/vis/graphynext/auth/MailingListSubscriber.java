/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * ログイン画面の任意チェックボックスでオプトインした、お知らせメール送付先。
 *
 * <p>マジックリンク経由でメールアドレスの実在を検証できた時点（{@code /auth/verify}成功時）で
 * 初めて登録する。取り出しは公開HTTPエンドポイントを持たず、
 * {@code deploy/demo/export-subscribers.sh} によるCLIエクスポートのみとする
 * （公開デモにメーリングリストを読み出せるAPIを持たせない）。
 */
@Entity
@Table(name = "mailing_list_subscriber")
public class MailingListSubscriber {

    @Id
    @Column(name = "email", length = 320)
    private String email;

    @Column(name = "subscribed_at", nullable = false)
    private Instant subscribedAt;

    protected MailingListSubscriber() {
        // JPA 用
    }

    public MailingListSubscriber(String email) {
        this.email = email;
        this.subscribedAt = Instant.now();
    }

    public String getEmail() {
        return email;
    }

    public Instant getSubscribedAt() {
        return subscribedAt;
    }
}
