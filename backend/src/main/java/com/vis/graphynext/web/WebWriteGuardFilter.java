/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import com.vis.graphynext.config.CorsProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.net.URI;
import java.util.List;

/**
 * web モードで、サーバーに書き込む・負荷をかける API を他のサイトのページから叩かれないようにする（CSRF 対策）。
 *
 * <p>対象は {@link #GUARDED} の表で持つ。対象には、独自ヘッダ {@value #HEADER} が無い要求と、
 * {@code Origin} が自分でも許可済みの CORS オリジンでもない要求を 403 で断る。
 * ブラウザは他のサイトからのフォーム送信に独自ヘッダを付けられない（付けるには CORS の事前確認が要り、
 * 許可していないオリジンは通らない）ので、ヘッダの有無で十分に見分けられる。
 */
@Component
@Profile("web")
public class WebWriteGuardFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Graphy-Request";

    private record Guarded(HttpMethod method, String pattern) {
    }

    /** 守る対象。web 取り込みなど、書き込みの API を足したらここに足す。 */
    private static final List<Guarded> GUARDED = List.of(
            new Guarded(HttpMethod.POST, "/api/anonymizer/jobs"),
            new Guarded(HttpMethod.DELETE, "/api/anonymizer/jobs/**"));

    private final AntPathMatcher matcher = new AntPathMatcher();
    private final CorsProperties cors;

    public WebWriteGuardFilter(CorsProperties cors) {
        this.cors = cors;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getServletPath();
        HttpMethod method = HttpMethod.valueOf(request.getMethod());
        boolean guarded = GUARDED.stream()
                .anyMatch(g -> g.method == method && matcher.match(g.pattern, path));
        if (guarded && (request.getHeader(HEADER) == null || !originAllowed(request))) {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"この要求は受け付けられません（" + HEADER + " ヘッダか Origin が不正です）\"}");
            return;
        }
        chain.doFilter(request, response);
    }

    /** Origin が無ければ（同一オリジンの一部の要求・非ブラウザ）可。あれば Host と同じか、許可済みオリジンのとき可。 */
    private boolean originAllowed(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        if (origin == null || origin.isBlank()) {
            return true;
        }
        String host = request.getHeader("Host");
        try {
            URI u = URI.create(origin);
            String authority = u.getPort() < 0 ? u.getHost() : u.getHost() + ":" + u.getPort();
            if (host != null && authority.equalsIgnoreCase(host)) {
                return true;
            }
        } catch (IllegalArgumentException e) {
            return false;
        }
        for (String pattern : cors.getAllowedOriginPatterns()) {
            if ("*".equals(pattern) || matcher.match(pattern, origin)) {
                return true;
            }
        }
        return false;
    }
}
