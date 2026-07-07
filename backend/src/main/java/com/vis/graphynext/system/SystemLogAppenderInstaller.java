/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.system;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import jakarta.annotation.PostConstruct;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * {@link SystemLogAppender} を {@code com.vis.graphynext} ロガーへ結線する。
 *
 * <p>logback-spring.xml を追加せずプログラム的に付与することで、Spring Boot 既定のコンソール
 * appender（stdout）はそのまま維持しつつ、同じログをインメモリ・リングバッファにも複製する。
 * additivity は既定（true）のままなので配下ロガーのイベントも本 appender へ伝播する。
 */
@Component
public class SystemLogAppenderInstaller {

    private static final String APPENDER_NAME = "graphySystemRing";
    private static final String TARGET_LOGGER = "com.vis.graphynext";

    @PostConstruct
    public void install() {
        if (!(LoggerFactory.getILoggerFactory() instanceof LoggerContext ctx)) {
            return; // logback 以外（想定外）なら何もしない
        }
        Logger target = ctx.getLogger(TARGET_LOGGER);
        if (target.getAppender(APPENDER_NAME) != null) {
            return; // 二重付与ガード（devtools リロード等）
        }
        SystemLogAppender appender = new SystemLogAppender();
        appender.setContext(ctx);
        appender.setName(APPENDER_NAME);
        appender.start();
        target.addAppender(appender);
    }
}
