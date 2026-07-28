/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

/**
 * お知らせメール登録者の永続化。アプリ本体のH2とは別のDBに保管する（理由は
 * {@link SubscriberDatabase} のクラスコメント参照）。
 *
 * <p>{@code graphy.auth.enabled=true} の環境でのみBean化する（{@link AuthController} と同条件）。
 */
@Repository
@ConditionalOnProperty(prefix = "graphy.auth", name = "enabled", havingValue = "true")
public class MailingListSubscriberRepository {

    /**
     * 旧構成（Hibernate の ddl-auto）が作っていた定義に合わせてある。列名・型を変えると
     * {@code deploy/demo/} 配下で退避したCSVをそのまま取り込めなくなるため揃えておく。
     * {@code Instant} に対応する型は Hibernate 6 と同じ {@code TIMESTAMP WITH TIME ZONE}。
     */
    private static final String DDL = """
            CREATE TABLE IF NOT EXISTS MAILING_LIST_SUBSCRIBER (
              EMAIL           VARCHAR(320) PRIMARY KEY,
              SUBSCRIBED_AT   TIMESTAMP(6) WITH TIME ZONE NOT NULL,
              UNSUBSCRIBED_AT TIMESTAMP(6) WITH TIME ZONE,
              PRODUCTS        VARCHAR(64) DEFAULT '%s' NOT NULL
            )
            """.formatted(SubscriptionProduct.allTokens());

    /**
     * PRODUCTS 列は後から足したもの（製品別配信への対応）。既に登録者DBが出来ている環境のために
     * 追加も流す。既定値を「全製品」にしてあるので、購読対象が記録されていない既存の登録者は
     * 両方の通知を受け取る側に倒れる——どちらに興味があったのか分からない以上、
     * 勝手に絞って届かなくするより、受け取れる状態にしておいて配信停止の判断を本人に委ねる。
     */
    private static final String DDL_PRODUCTS_COLUMN = """
            ALTER TABLE MAILING_LIST_SUBSCRIBER
              ADD COLUMN IF NOT EXISTS PRODUCTS VARCHAR(64) DEFAULT '%s' NOT NULL
            """.formatted(SubscriptionProduct.allTokens());

    private final JdbcTemplate jdbc;

    public MailingListSubscriberRepository(SubscriberDatabase database) {
        this.jdbc = database.jdbc();
        this.jdbc.execute(DDL);
        this.jdbc.execute(DDL_PRODUCTS_COLUMN);
    }

    public Optional<MailingListSubscriber> findByEmail(String email) {
        List<MailingListSubscriber> rows = jdbc.query(
                "SELECT EMAIL, SUBSCRIBED_AT, UNSUBSCRIBED_AT, PRODUCTS"
                        + " FROM MAILING_LIST_SUBSCRIBER WHERE EMAIL = ?",
                MailingListSubscriberRepository::mapRow,
                email);
        return rows.stream().findFirst();
    }

    /**
     * 指定製品の更新通知を送るべき宛先。配信停止済みは<b>常に</b>除外する
     * （呼び出し側が条件を書き忘れても停止済みへ送れないようにするため、ここで閉じ込める）。
     */
    public List<MailingListSubscriber> findActiveByProduct(SubscriptionProduct product) {
        // PRODUCTS はトークンのカンマ区切り。単純な部分一致だと "graphy" が "graphy-next" にも
        // 当たってしまうため、両端をカンマで囲って ",graphy," のように区切り込みで探す。
        return jdbc.query(
                "SELECT EMAIL, SUBSCRIBED_AT, UNSUBSCRIBED_AT, PRODUCTS FROM MAILING_LIST_SUBSCRIBER"
                        + " WHERE UNSUBSCRIBED_AT IS NULL"
                        + " AND POSITION(? IN CONCAT(',', PRODUCTS, ',')) > 0"
                        + " ORDER BY SUBSCRIBED_AT",
                MailingListSubscriberRepository::mapRow,
                "," + product.token() + ",");
    }

    /** 新規登録・更新のどちらも受ける（メールアドレスが主キー）。 */
    public void save(MailingListSubscriber subscriber) {
        jdbc.update("""
                MERGE INTO MAILING_LIST_SUBSCRIBER (EMAIL, SUBSCRIBED_AT, UNSUBSCRIBED_AT, PRODUCTS)
                KEY(EMAIL) VALUES (?, ?, ?, ?)
                """,
                subscriber.getEmail(),
                toOffsetDateTime(subscriber.getSubscribedAt()),
                toOffsetDateTime(subscriber.getUnsubscribedAt()),
                SubscriptionProduct.join(subscriber.getProducts()));
    }

    private static MailingListSubscriber mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new MailingListSubscriber(
                rs.getString("EMAIL"),
                toInstant(rs.getObject("SUBSCRIBED_AT", OffsetDateTime.class)),
                toInstant(rs.getObject("UNSUBSCRIBED_AT", OffsetDateTime.class)),
                SubscriptionProduct.parse(rs.getString("PRODUCTS")));
    }

    private static Instant toInstant(OffsetDateTime value) {
        return value == null ? null : value.toInstant();
    }

    private static OffsetDateTime toOffsetDateTime(Instant value) {
        return value == null ? null : OffsetDateTime.ofInstant(value, ZoneOffset.UTC);
    }
}
