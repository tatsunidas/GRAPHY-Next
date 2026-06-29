/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.settings;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * デバッグモードに応じて {@code com.vis.graphynext} のログレベルを実行時に切り替える。
 *
 * <p>ON で DEBUG（リスク箇所・未検証箇所の debug ログが標準出力に出る）、OFF で INFO。
 * Spring Boot 既定の Logback を直接操作する。
 */
@Component
public class DebugLogControl {

    private static final Logger log = LoggerFactory.getLogger(DebugLogControl.class);
    private static final String PACKAGE = "com.vis.graphynext";

    public void apply(boolean debug) {
        Logger pkgLogger = LoggerFactory.getLogger(PACKAGE);
        if (pkgLogger instanceof ch.qos.logback.classic.Logger logback) {
            logback.setLevel(debug ? ch.qos.logback.classic.Level.DEBUG : ch.qos.logback.classic.Level.INFO);
            log.info("デバッグモード={} ({}={})", debug, PACKAGE, debug ? "DEBUG" : "INFO");
        } else {
            log.warn("Logback ではないためログレベルを動的変更できません: {}", pkgLogger.getClass());
        }
    }
}
