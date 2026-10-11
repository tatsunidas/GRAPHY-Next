/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.startup;

import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * 起動の進捗で、データベースの段階を実際の処理の範囲だけにする（standalone のみ）。
 *
 * <p>H2 を開く処理と Hibernate の表の確認・更新は、{@code entityManagerFactory} の初期化の中で行われる。
 * その前後で段階を切り替える: 部品の準備（context）→ データベース（database）→ 機能の準備（services）。
 * 以前は Spring の準備の全体を「データベース」と出していたため、DB 以外の時間（起動の大半）まで
 * 「データベースを確認しています」のまま待たせていた（2026-10-11 の計測で DB は約 2.5 秒／全体 11.5 秒）。
 */
@Component
@Profile("standalone")
public class DatabaseStartupProgress implements BeanPostProcessor {

    static final String EMF = "entityManagerFactory";

    interface Reporter {
        void report(String step, String state, String message);
    }

    private final Reporter reporter;
    /**
     * entityManagerFactory は FactoryBean なので、初期化の後の処理は「作る側」と「作られた本体」の 2 回呼ばれる。
     * 段階の切り替えは 1 回だけにする。
     */
    private final java.util.concurrent.atomic.AtomicBoolean before = new java.util.concurrent.atomic.AtomicBoolean();
    private final java.util.concurrent.atomic.AtomicBoolean after = new java.util.concurrent.atomic.AtomicBoolean();

    public DatabaseStartupProgress() {
        this(StartupProgress::report);
    }

    DatabaseStartupProgress(Reporter reporter) {
        this.reporter = reporter;
    }

    @Override
    public Object postProcessBeforeInitialization(Object bean, String beanName) {
        if (EMF.equals(beanName) && before.compareAndSet(false, true)) {
            reporter.report("context", "ok", "アプリの部品の準備が進みました");
            reporter.report("database", "running", "データベースを開いて確認しています");
        }
        return bean;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (EMF.equals(beanName) && after.compareAndSet(false, true)) {
            reporter.report("database", "ok", "データベースの準備が完了しました");
            reporter.report("services", "running", "機能を準備しています");
        }
        return bean;
    }
}
