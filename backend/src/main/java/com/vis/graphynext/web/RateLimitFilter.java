/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import com.vis.graphynext.config.RateLimitProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 公開デモ（{@code graphy.ratelimit.enabled=true}）でのみ有効化される、IP 単位の簡易レート制限。
 *
 * <p>デモサーバーは自宅のゲストWiFi回線＋非マネージドの物理機で運用しており、帯域上限も
 * オートスケールもない。認証なしで閲覧系 API を誰でも叩けるため、クローラー等による意図しない
 * 高頻度アクセスだけでもサーバーの可用性を損ないうる。固定ウィンドウ方式で 1 分あたりの
 * リクエスト数を IP ごとに数え、超過分は 429 で拒否する。
 *
 * <p>クライアント IP は Cloudflare エッジが付与する {@code CF-Connecting-IP} を信頼する。
 * このデモ環境では graphy-backend への到達経路が cloudflared → proxy(nginx) 経由のみ（Docker の
 * {@code internal: true} ネットワークでホストへの ports: publish 自体が存在しない）ため、
 * このヘッダーを第三者が偽装してこのフィルタに直接届けることはできない
 * （proxy はヘッダーを素通しするのみで書き換えない）。
 */
@Component
@ConditionalOnProperty(prefix = "graphy.ratelimit", name = "enabled", havingValue = "true")
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RateLimitFilter extends OncePerRequestFilter {

    private static final long WINDOW_MILLIS = 60_000;
    private static final int CLEANUP_SAMPLE_RATE = 500;

    private final int requestsPerMinute;
    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

    public RateLimitFilter(RateLimitProperties properties) {
        this.requestsPerMinute = properties.getRequestsPerMinute();
    }

    private static final class Window {
        long windowStart;
        int count;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        String ip = clientIp(request);
        long now = System.currentTimeMillis();

        Window window = windows.computeIfAbsent(ip, key -> new Window());
        boolean exceeded;
        synchronized (window) {
            if (now - window.windowStart >= WINDOW_MILLIS) {
                window.windowStart = now;
                window.count = 0;
            }
            window.count++;
            exceeded = window.count > requestsPerMinute;
        }

        if (ThreadLocalRandom.current().nextInt(CLEANUP_SAMPLE_RATE) == 0) {
            cleanup(now);
        }

        if (exceeded) {
            response.setStatus(429);
            response.setHeader("Retry-After", "60");
            response.setContentType("application/json");
            response.getWriter().write(
                    "{\"error\":\"リクエストが多すぎます。しばらく待ってから再試行してください\"}");
            return;
        }
        chain.doFilter(request, response);
    }

    private void cleanup(long now) {
        windows.entrySet().removeIf(entry -> now - entry.getValue().windowStart >= WINDOW_MILLIS * 2);
    }

    private static String clientIp(HttpServletRequest request) {
        String cfIp = request.getHeader("CF-Connecting-IP");
        if (cfIp != null && !cfIp.isBlank()) {
            return cfIp;
        }
        String forwardedFor = request.getHeader("X-Forwarded-For");
        if (forwardedFor != null && !forwardedFor.isBlank()) {
            return forwardedFor.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }
}
