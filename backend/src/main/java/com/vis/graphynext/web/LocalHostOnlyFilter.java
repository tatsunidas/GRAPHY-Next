/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Locale;
import java.util.Set;

/**
 * standalone は宛先のホスト名が localhost のときだけ受ける（DNS リバインディング対策）。
 *
 * <p>待ち受けは 127.0.0.1 だけだが、それでも普通のブラウザで開いた悪意あるページは、自分のドメインを
 * 127.0.0.1 に向け直す（DNS リバインディング）ことで「同一オリジン」として API を呼べる。そのとき
 * {@code Host} は相手のドメインのままなので、ここで弾く（2026-10-11 実測: 偽の Host で設定の書き換えが 200）。
 *
 * <p>正規の呼び出しは Electron の画面（{@code localhost:<port>}）、起動の確認（{@code 127.0.0.1}）、
 * 開発時の Vite の中継（{@code localhost:<Vite のポート>}）だけ。ポートは問わない。
 */
@Component
@Profile("standalone")
@Order(Ordered.HIGHEST_PRECEDENCE)
public class LocalHostOnlyFilter extends OncePerRequestFilter {

    private static final Set<String> HOSTS = Set.of("localhost", "127.0.0.1", "[::1]");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        HttpServletRequest raw = (HttpServletRequest) RawRequest.unwrap(request);
        String host = raw.getHeader("Host");
        // Host の無い要求（HTTP/1.0 など）はブラウザからは作れない（ブラウザは必ず Host を付ける）ので通す
        if (host == null || allowedHost(host)) {
            chain.doFilter(request, response);
            return;
        }
        response.sendError(HttpServletResponse.SC_FORBIDDEN, "local-only");
    }

    /** {@code Host} ヘッダ（{@code name[:port]}、IPv6 は {@code [::1]:port}）のホスト名が localhost か。 */
    static boolean allowedHost(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String h = host.strip().toLowerCase(Locale.ROOT);
        String name;
        if (h.startsWith("[")) {
            int end = h.indexOf(']');
            if (end < 0) {
                return false;
            }
            name = h.substring(0, end + 1);
            String rest = h.substring(end + 1);
            if (!rest.isEmpty() && !rest.matches(":\\d{1,5}")) {
                return false;
            }
        } else {
            int colon = h.indexOf(':');
            name = colon < 0 ? h : h.substring(0, colon);
            if (colon >= 0 && !h.substring(colon).matches(":\\d{1,5}")) {
                return false;
            }
        }
        return HOSTS.contains(name);
    }
}
