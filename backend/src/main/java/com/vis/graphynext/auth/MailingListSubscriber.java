/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import java.time.Instant;
import java.util.EnumSet;
import java.util.Set;

/**
 * お知らせメール送付先。ログイン画面の任意チェックボックス、および graphy.vis-ionary.com の
 * 更新通知登録フォーム（{@code POST /subscribe}）から登録される。
 *
 * <p>ログイン画面経由の場合は、マジックリンクでメールアドレスの実在を検証できた時点
 * （{@code /auth/verify}成功時）で初めて登録する。配信停止（{@code /unsubscribe}）は行を削除せず
 * {@code unsubscribedAt} を立てるだけの方式にしている。削除してしまうと「一度止めた」という事実自体が
 * 消え、将来別ソースから再取り込みした際にうっかり復活させてしまうリスクがあるため。
 *
 * <p>取り出しは公開HTTPエンドポイントを持たず、{@code deploy/demo/export-subscribers.sh} による
 * CLIエクスポートのみとする（公開デモにメーリングリストを読み出せるAPIを持たせない）。
 *
 * <p><b>JPAエンティティではない。</b> このテーブルだけはアプリ本体のH2とは別のDBファイルに保管しており
 * （理由は {@link MailingListSubscriberRepository} のクラスコメント参照）、素のJDBCで読み書きする
 * 単なるドメイン型として扱う。
 */
public class MailingListSubscriber {

    private final String email;
    private Instant subscribedAt;
    private Instant unsubscribedAt;
    private final Set<SubscriptionProduct> products;

    public MailingListSubscriber(String email, Set<SubscriptionProduct> products) {
        this(email, Instant.now(), null, products);
    }

    /** DBの1行から復元する。 */
    public MailingListSubscriber(String email, Instant subscribedAt, Instant unsubscribedAt,
            Set<SubscriptionProduct> products) {
        this.email = email;
        this.subscribedAt = subscribedAt;
        this.unsubscribedAt = unsubscribedAt;
        // EnumSet.copyOf は空コレクションを渡すと落ちるため、明示的に組み立てる。
        this.products = EnumSet.noneOf(SubscriptionProduct.class);
        this.products.addAll(products);
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

    /** 更新通知を受け取る対象の製品。 */
    public Set<SubscriptionProduct> getProducts() {
        return EnumSet.copyOf(products);
    }

    /**
     * 購読対象を追加する（差し替えではなく和集合）。
     *
     * <p>例えば GRAPHY-Next のページで登録済みの人が、後日 GRAPHY のページからも登録した場合、
     * 上書きすると先に登録していた Next の通知が届かなくなる。本人は「増やした」つもりなので、
     * 常に足す方向にしか動かさない。減らすのは配信停止（{@link #unsubscribe()}）だけ。
     */
    public void addProducts(Set<SubscriptionProduct> additional) {
        this.products.addAll(additional);
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
