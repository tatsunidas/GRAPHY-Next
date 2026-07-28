/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
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
 * 更新通知の配信履歴。登録者と同じ別DB（{@link SubscriberDatabase}）に置く。
 *
 * <p>{@code graphy.auth.enabled=true} の環境でのみBean化する。
 */
@Repository
@ConditionalOnProperty(prefix = "graphy.auth", name = "enabled", havingValue = "true")
public class AnnouncementDeliveryRepository {

    private static final String DDL = """
            CREATE TABLE IF NOT EXISTS ANNOUNCEMENT_DELIVERY (
              PRODUCT         VARCHAR(32) NOT NULL,
              VERSION         VARCHAR(64) NOT NULL,
              STARTED_AT      TIMESTAMP(6) WITH TIME ZONE NOT NULL,
              FINISHED_AT     TIMESTAMP(6) WITH TIME ZONE,
              RECIPIENT_COUNT INT NOT NULL DEFAULT 0,
              FAILED_COUNT    INT NOT NULL DEFAULT 0,
              PRIMARY KEY (PRODUCT, VERSION)
            )
            """;

    private final JdbcTemplate jdbc;

    public AnnouncementDeliveryRepository(SubscriberDatabase database) {
        this.jdbc = database.jdbc();
        this.jdbc.execute(DDL);
    }

    /**
     * この (製品, バージョン) の配信権を確保する。
     *
     * <p>実際に送り始める<b>前に</b>行を作るのが要点。送信し終えてから記録する作りだと、
     * 配信の途中でプロセスが落ちた場合や、cronが重なって同時に叩かれた場合に、
     * 同じリリースの通知が二重に飛ぶ。主キー衝突で弾くことで、送信前に確実に排他できる。
     *
     * @return 確保できた（＝まだ誰も送っていない）なら true
     */
    public boolean claim(SubscriptionProduct product, String version) {
        try {
            jdbc.update("INSERT INTO ANNOUNCEMENT_DELIVERY (PRODUCT, VERSION, STARTED_AT) VALUES (?, ?, ?)",
                    product.token(), version, OffsetDateTime.now(ZoneOffset.UTC));
            return true;
        } catch (DuplicateKeyException e) {
            return false;
        }
    }

    public void complete(SubscriptionProduct product, String version, int recipientCount, int failedCount) {
        jdbc.update("""
                UPDATE ANNOUNCEMENT_DELIVERY
                   SET FINISHED_AT = ?, RECIPIENT_COUNT = ?, FAILED_COUNT = ?
                 WHERE PRODUCT = ? AND VERSION = ?
                """,
                OffsetDateTime.now(ZoneOffset.UTC), recipientCount, failedCount,
                product.token(), version);
    }

    /**
     * 配信権の確保を取り消す。宛先0件や、送信を1通も試みる前に失敗した場合に呼ぶ。
     * 残しておくと「送信済み」と区別できず、原因を直しても再送できなくなるため。
     */
    public void release(SubscriptionProduct product, String version) {
        jdbc.update("DELETE FROM ANNOUNCEMENT_DELIVERY WHERE PRODUCT = ? AND VERSION = ?",
                product.token(), version);
    }

    public Optional<AnnouncementDelivery> find(SubscriptionProduct product, String version) {
        List<AnnouncementDelivery> rows = jdbc.query(
                "SELECT PRODUCT, VERSION, STARTED_AT, FINISHED_AT, RECIPIENT_COUNT, FAILED_COUNT"
                        + " FROM ANNOUNCEMENT_DELIVERY WHERE PRODUCT = ? AND VERSION = ?",
                AnnouncementDeliveryRepository::mapRow,
                product.token(), version);
        return rows.stream().findFirst();
    }

    private static AnnouncementDelivery mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new AnnouncementDelivery(
                rs.getString("PRODUCT"),
                rs.getString("VERSION"),
                toInstant(rs.getObject("STARTED_AT", OffsetDateTime.class)),
                toInstant(rs.getObject("FINISHED_AT", OffsetDateTime.class)),
                rs.getInt("RECIPIENT_COUNT"),
                rs.getInt("FAILED_COUNT"));
    }

    private static Instant toInstant(OffsetDateTime value) {
        return value == null ? null : value.toInstant();
    }
}
