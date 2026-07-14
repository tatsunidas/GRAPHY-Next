/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code graphy.ratelimit.*}（application-demo.yml）を束縛する設定。
 *
 * <p>公開デモを IP 単位のリクエスト数で簡易制限するための閾値を外部設定化する。
 */
@ConfigurationProperties(prefix = "graphy.ratelimit")
public class RateLimitProperties {

    /** レート制限フィルタを有効化するか。 */
    private boolean enabled = false;

    /** 1 IP あたり 1 分間に許可するリクエスト数。 */
    private int requestsPerMinute = 300;

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public int getRequestsPerMinute() {
        return requestsPerMinute;
    }

    public void setRequestsPerMinute(int requestsPerMinute) {
        this.requestsPerMinute = requestsPerMinute;
    }
}
