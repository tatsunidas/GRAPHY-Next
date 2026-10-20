/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import java.time.Clock;
import java.util.concurrent.ConcurrentHashMap;

/**
 * IP ごとの失敗回数の固定ウィンドウ（1 分）。共有リンクの入口と管理 API の「当てずっぽう」を止める。
 * 成功は数えない。{@link #blocked} が真なら、その IP は次の窓まで 429。
 */
final class FailureLimiter {

    private static final long WINDOW_MILLIS = 60_000;

    private static final class Window {
        long start;
        int failures;
    }

    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();
    private final int limit;
    private final Clock clock;

    FailureLimiter(int limit, Clock clock) {
        this.limit = limit;
        this.clock = clock;
    }

    boolean blocked(String ip) {
        Window w = windows.get(ip);
        if (w == null) {
            return false;
        }
        synchronized (w) {
            return clock.millis() - w.start < WINDOW_MILLIS && w.failures >= limit;
        }
    }

    void recordFailure(String ip) {
        long now = clock.millis();
        Window w = windows.computeIfAbsent(ip, k -> new Window());
        synchronized (w) {
            if (now - w.start >= WINDOW_MILLIS) {
                w.start = now;
                w.failures = 0;
            }
            w.failures++;
        }
        if (windows.size() > 10_000) {
            windows.entrySet().removeIf(e -> now - e.getValue().start >= WINDOW_MILLIS * 2);
        }
    }
}
