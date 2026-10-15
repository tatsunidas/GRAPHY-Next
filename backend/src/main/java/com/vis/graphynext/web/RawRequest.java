/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletRequestWrapper;

/**
 * ラッパーをはがした、サーブレットコンテナが受け取ったままの要求。
 *
 * <p>{@code forward-headers-strategy: framework} では、外側のラッパーが {@code X-Forwarded-For} /
 * {@code X-Forwarded-Host} で接続元やホスト名を書き換える。これらは要求を送る側が自由に付けられるので、
 * 「この PC からか」「宛先が localhost か」の判定には、はがした生の値を使う。
 */
public final class RawRequest {

    private RawRequest() {
    }

    public static ServletRequest unwrap(ServletRequest request) {
        ServletRequest raw = request;
        while (raw instanceof ServletRequestWrapper w) {
            raw = w.getRequest();
        }
        return raw;
    }
}
