/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.system;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.AppenderBase;

/**
 * Logback イベントを {@link SystemLogStore} へ流し込む appender。
 *
 * <p>{@link SystemLogAppenderInstaller} が {@code com.vis.graphynext} ロガーへ結線するので、
 * 本アプリ配下（DIMSE / DICOMweb / 取り込み等）のログのみを拾い、Tomcat/Spring 内部ログは拾わない。
 * 例外付きログは throwable の先頭情報も 1 行に畳んで残す（movescu の exit/末尾は既に整形済み
 * メッセージに含まれるためそのまま見える）。
 */
public class SystemLogAppender extends AppenderBase<ILoggingEvent> {

    @Override
    protected void append(ILoggingEvent e) {
        String msg = e.getFormattedMessage();
        IThrowableProxy tp = e.getThrowableProxy();
        if (tp != null) {
            msg = msg + " | " + tp.getClassName()
                    + (tp.getMessage() != null ? ": " + tp.getMessage() : "");
        }
        SystemLogStore.add(e.getTimeStamp(), e.getLevel().toString(), shortName(e.getLoggerName()), msg);
    }

    /** {@code a.b.c.QrRetrieveService} → {@code qr.QrRetrieveService}（出所を短く判別可能に）。 */
    private static String shortName(String name) {
        if (name == null || name.isEmpty()) {
            return "";
        }
        int dotClass = name.lastIndexOf('.');
        if (dotClass < 0) {
            return name;
        }
        int dotPkg = name.lastIndexOf('.', dotClass - 1);
        return dotPkg < 0 ? name : name.substring(dotPkg + 1);
    }
}
