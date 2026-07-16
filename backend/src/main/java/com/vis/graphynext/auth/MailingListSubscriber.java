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
 * 初めて登録する。配信停止（{@code /unsubscribe}）は行を削除せず {@code unsubscribedAt} を
 * 立てるだけの方式にしている。削除してしまうと「一度止めた」という事実自体が消え、将来別ソースから
 * 再取り込みした際にうっかり復活させてしまうリスクがあるため。
 *
 * <p>取り出しは公開HTTPエンドポイントを持たず、{@code deploy/demo/export-subscribers.sh} による
 * CLIエクスポートのみとする（公開デモにメーリングリストを読み出せるAPIを持たせない）。
 */
@Entity
@Table(name = "mailing_list_subscriber")
public class MailingListSubscriber {

    @Id
    @Column(name = "email", length = 320)
    private String email;

    @Column(name = "subscribed_at", nullable = false)
    private Instant subscribedAt;

    @Column(name = "unsubscribed_at")
    private Instant unsubscribedAt;

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

    public Instant getUnsubscribedAt() {
        return unsubscribedAt;
    }

    public boolean isUnsubscribed() {
        return unsubscribedAt != null;
    }

    public void unsubscribe() {
        this.unsubscribedAt = Instant.now();
    }

    /** 一度配信停止した相手が、後日改めてオプトインし直した場合に呼ぶ。 */
    public void resubscribe() {
        this.unsubscribedAt = null;
        this.subscribedAt = Instant.now();
    }
}
