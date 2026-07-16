/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import com.vis.graphynext.auth.SessionTokenService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * 公開デモ（{@code graphy.auth.enabled=true}）でのみ有効化される、マジックリンクログインのゲート。
 *
 * <p>{@code /login}・{@code /auth/**}・{@code /unsubscribe}・{@code /subscribe} 以外の全リクエストで
 * {@code graphy_session} Cookie の署名・有効期限を検証する。未ログインの場合、ページ遷移
 * （HTML想定）は {@code /login} へリダイレクト、{@code /api/**}（フロントのXHR/fetch想定）は
 * 401 を返す。{@code /unsubscribe}・{@code /subscribe} はログイン状態に関係なく常に到達可能にする
 * （前者は配信停止導線、後者はXserver側subscribe.phpからのサーバー間呼び出しで、
 * どちらもセッションCookieを持たない）。
 */
@Component
@ConditionalOnProperty(prefix = "graphy.auth", name = "enabled", havingValue = "true")
public class AuthFilter extends OncePerRequestFilter {

    private static final String SESSION_COOKIE_NAME = "graphy_session";

    private final SessionTokenService sessionTokenService;

    public AuthFilter(SessionTokenService sessionTokenService) {
        this.sessionTokenService = sessionTokenService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        String path = request.getServletPath();

        if (isAllowListed(path) || sessionTokenService.verify(sessionCookieValue(request)).isPresent()) {
            chain.doFilter(request, response);
            return;
        }

        if (path.startsWith("/api/")) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"ログインが必要です\"}");
            return;
        }

        String queryString = request.getQueryString();
        String next = path + (queryString != null ? "?" + queryString : "");
        String encodedNext = URLEncoder.encode(next, StandardCharsets.UTF_8);
        response.sendRedirect("/login?next=" + encodedNext);
    }

    private static boolean isAllowListed(String path) {
        return path.equals("/login")
                || path.startsWith("/auth/")
                || path.equals("/unsubscribe")
                || path.equals("/subscribe")
                || path.equals("/actuator/health")
                || path.equals("/actuator/info");
    }

    private static String sessionCookieValue(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie cookie : cookies) {
            if (SESSION_COOKIE_NAME.equals(cookie.getName())) {
                return cookie.getValue();
            }
        }
        return null;
    }
}
