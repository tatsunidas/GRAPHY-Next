/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 共有サービス（{@code graphy.share.enabled=true}）の認可ゲート。<b>許可リスト方式</b>。
 *
 * <p>デモの {@code DemoModeFilter} は「塞ぐ経路を並べる」方式だが、ここは逆で「通す経路だけを並べる」
 * （{@link ShareRoutes}）。受け手は登録も認証もしていない第三者なので、新しい API を足したときに
 * 黙って見えてしまう側に倒さない。
 *
 * <ul>
 *   <li>{@code /api/**}・{@code /actuator/**}（health を除く）は、有効な共有 Cookie が要る。無効・期限切れ・
 *       取り消しは <b>404</b>（理由を区別しない）。許可リストに無い経路・メソッドも 404。</li>
 *   <li>許可された形で<b>許可範囲外の検査</b>を指すと 403（SOP 指定は台帳から検査を引く。不在も 403 で区別しない）。</li>
 *   <li>共有の入口 {@code /s/**} と管理 API は別の認証（トークン／管理鍵）を自分で持つので通す。
 *       画面の静的ファイル（{@code /api} 以外の GET）は公開（アプリのコードだけで患者データは無い）。</li>
 *   <li>応答は {@code no-store}・{@code no-referrer}。コントローラが付ける {@code max-age} は上書きする。</li>
 * </ul>
 */
@Component
@ConditionalOnProperty(prefix = "graphy.share", name = "enabled", havingValue = "true")
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class ShareAccessFilter extends OncePerRequestFilter {

    static final String COOKIE_NAME = "graphy_share";
    static final String GRANT_ATTR = "graphy.share.grant";
    static final String ADMIN_PATH = "/api/share/grants";
    private static final String NOT_FOUND = "{\"error\":\"not found\"}";

    private final ShareService service;
    private final DicomInstanceRepository instances;

    public ShareAccessFilter(ShareService service, DicomInstanceRepository instances) {
        this.service = service;
        this.instances = instances;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String uri = request.getRequestURI();
        HttpServletResponse guarded = new NoStoreResponse(response);

        if (uri.equals("/s") || uri.startsWith("/s/") || uri.equals(ADMIN_PATH) || uri.startsWith(ADMIN_PATH + "/")) {
            chain.doFilter(request, guarded);
            return;
        }
        boolean protectedPath = uri.startsWith("/api/")
                || (uri.startsWith("/actuator") && !uri.equals("/actuator/health"));
        if (!protectedPath) {
            String m = request.getMethod();
            if ("GET".equals(m) || "HEAD".equals(m)) {
                chain.doFilter(request, response); // 画面の静的ファイル。患者データは無い
            } else {
                notFound(guarded);
            }
            return;
        }

        ShareGrant grant = service.verifySession(cookie(request)).orElse(null);
        if (grant == null) {
            notFound(guarded);
            return;
        }
        ShareRoutes.Route route = ShareRoutes.parse(request.getMethod(), uri).orElse(null);
        if (route == null) {
            notFound(guarded);
            return;
        }
        if (!allowed(grant, route)) {
            guarded.setStatus(HttpServletResponse.SC_FORBIDDEN);
            guarded.setContentType("application/json");
            guarded.getWriter().write("{\"error\":\"forbidden\"}");
            return;
        }
        request.setAttribute(GRANT_ATTR, grant);
        chain.doFilter(request, guarded);
    }

    private boolean allowed(ShareGrant grant, ShareRoutes.Route route) {
        return switch (route.kind()) {
            case SHARE_INFO -> true;
            case STUDY -> grant.getStudyUids().contains(route.studyUid());
            case INSTANCE -> {
                List<DicomInstance> found = instances.findMatches(null, null, null, route.sopUid());
                yield !found.isEmpty() && found.stream()
                        .allMatch(i -> grant.getStudyUids().contains(i.getStudyInstanceUid()));
            }
        };
    }

    private static String cookie(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie c : cookies) {
            if (COOKIE_NAME.equals(c.getName())) {
                return c.getValue();
            }
        }
        return null;
    }

    private static void notFound(HttpServletResponse response) throws IOException {
        response.setStatus(HttpServletResponse.SC_NOT_FOUND);
        response.setContentType("application/json");
        response.getWriter().write(NOT_FOUND);
    }

    /** キャッシュ・Referer 系のヘッダを固定し、後段（コントローラ）の上書きを無視する。 */
    private static final class NoStoreResponse extends HttpServletResponseWrapper {
        NoStoreResponse(HttpServletResponse response) {
            super(response);
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Referrer-Policy", "no-referrer");
            response.setHeader("X-Content-Type-Options", "nosniff");
        }

        private static boolean fixed(String name) {
            return "Cache-Control".equalsIgnoreCase(name) || "Referrer-Policy".equalsIgnoreCase(name)
                    || "X-Content-Type-Options".equalsIgnoreCase(name) || "Pragma".equalsIgnoreCase(name)
                    || "Expires".equalsIgnoreCase(name);
        }

        @Override
        public void setHeader(String name, String value) {
            if (!fixed(name)) {
                super.setHeader(name, value);
            }
        }

        @Override
        public void addHeader(String name, String value) {
            if (!fixed(name)) {
                super.addHeader(name, value);
            }
        }

        @Override
        public void setDateHeader(String name, long date) {
            if (!fixed(name)) {
                super.setDateHeader(name, date);
            }
        }

        @Override
        public void addDateHeader(String name, long date) {
            if (!fixed(name)) {
                super.addDateHeader(name, date);
            }
        }
    }
}
