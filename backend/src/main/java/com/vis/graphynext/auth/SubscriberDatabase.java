/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import com.vis.graphynext.config.AuthProperties;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * お知らせメール関連（登録者・配信履歴）だけを保管する、<b>アプリ本体とは別のH2</b>への接続。
 *
 * <h2>なぜ分けるのか</h2>
 * 公開デモは毎晩0:00に {@code deploy/demo/reset-demo.sh} が {@code /app/data}（＝アプリ本体のH2）を
 * ゴールデンスナップショットへ丸ごと戻す。夜間リセットの導入（2026-07-14）がメーリングリストの
 * 追加（2026-07-16）より先だったため、同居していた登録者テーブルは毎晩まとめて消えていた
 * （日中の登録が翌0:00に全損する状態だった）。リセットが触らない別ボリュームへ物理的に分けることで、
 * リセット手順の書き方に依存せず登録者が守られる。接続先は {@code graphy.auth.subscriber-db-url}。
 *
 * <h2>なぜJPAでもSpring管理のDataSourceでもないのか</h2>
 * Spring Boot の {@code DataSourceAutoConfiguration} は {@code @ConditionalOnMissingBean(DataSource.class)}
 * のため、2つ目の {@code DataSource} を Bean として宣言すると<b>本体側の自動設定が丸ごと止まり</b>、
 * DICOM保管庫・レポート・設定の永続化まで手書きの構成に巻き込むことになる。数テーブルのために
 * そのリスクを取る価値はないので、接続プールをこのクラスの内部に閉じ込め（Beanの型を
 * {@code DataSource} にしない）、素のJDBCで読み書きする。結果として本体側の永続化構成には
 * 一切手を触れていない。
 *
 * <p>{@code graphy.auth.enabled=true} の環境でのみBean化する（{@link AuthController} と同条件）。
 */
@Component
@ConditionalOnProperty(prefix = "graphy.auth", name = "enabled", havingValue = "true")
public class SubscriberDatabase {

    private static final Logger log = LoggerFactory.getLogger(SubscriberDatabase.class);

    private final HikariDataSource dataSource;
    private final JdbcTemplate jdbc;

    public SubscriberDatabase(AuthProperties properties) {
        this.dataSource = new HikariDataSource();
        this.dataSource.setPoolName("subscriber-db");
        this.dataSource.setJdbcUrl(properties.getSubscriberDbUrl());
        this.dataSource.setDriverClassName("org.h2.Driver");
        this.dataSource.setUsername("sa");
        this.dataSource.setPassword("");
        // 書き込みは1日に数件あるかどうか。プールは最小限にし、常時1本だけ開けておく
        // （AUTO_SERVER のH2サーバーが立ったままになり、export-subscribers.sh が即座に接続できる）。
        this.dataSource.setMaximumPoolSize(2);
        this.dataSource.setMinimumIdle(1);

        this.jdbc = new JdbcTemplate(this.dataSource);
        log.info("お知らせメール用DBを開きました: {}", properties.getSubscriberDbUrl());
    }

    public JdbcTemplate jdbc() {
        return jdbc;
    }

    @PreDestroy
    void close() {
        dataSource.close();
    }
}
