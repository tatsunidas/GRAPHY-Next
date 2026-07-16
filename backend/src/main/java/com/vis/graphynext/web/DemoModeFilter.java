/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 公開デモ（{@code graphy.demo.enabled=true}）でのみ有効化されるガード。
 *
 * <p>閲覧（検索・2D/MPR/3D/Slicer/CurvedMPR 表示）は許可したまま、以下を一律で 403 にする:
 * データの持ち込み（非DICOMインポート・任意パスインポート）、持ち出し（RTSTRUCT/派生シリーズの
 * PACS 書き戻し・study/シリーズ抽出のZIP/コピー・匿名化ツールのZIP/コピー/マスク書き込み）、
 * 外部 DICOM ノードへの通信（送信・Query/Retrieve・C-ECHO＝SSRF相当）、DB 管理系の破壊的操作、
 * サーバー設定（TLS設定・アプリ設定）の書き換え、サーバーログ・ImageJ ブリッジ・プラグイン実行など
 * サーバー内部に触れる操作。レポート機能（{@code /api/reports/**}）と SEG 書き出し
 * （{@code POST /api/dicom/seg}）はデモ体験として意図的に許可したままにしており、代わりに
 * 毎晩の自動リストアで荒らし・蓄積データをリセットする運用にしている（fw/web-demo-hosting.md 参照）。
 *
 * <p>個別コントローラへ {@code @Profile}/{@code @ConditionalOnProperty} を都度付けるのではなく、
 * 経路を一箇所のホワイトリスト外ブロックとして集約することで、新規エンドポイント追加時の
 * ガード漏れ（実際に今回の調査で複数見つかった）を構造的に防ぐ。
 */
@Component
@ConditionalOnProperty(prefix = "graphy.demo", name = "enabled", havingValue = "true")
public class DemoModeFilter extends OncePerRequestFilter {

    private record BlockedRoute(HttpMethod method, String pattern) {
        boolean matches(HttpMethod requestMethod, String path, AntPathMatcher matcher) {
            return (method == null || method == requestMethod) && matcher.match(pattern, path);
        }
    }

    private static final List<BlockedRoute> BLOCKED = List.of(
            new BlockedRoute(null, "/api/import/**"),
            new BlockedRoute(HttpMethod.POST, "/api/dicom/send"),
            new BlockedRoute(null, "/api/dicom/qr/**"),
            // POST /api/dicom/seg（SEG書き出し）は毎晩の自動リストア（reset-demo.sh）で確実に
            // 消えるため、他の「持ち出し」系と異なりデモ体験として意図的に許可している
            // （fw/web-demo-hosting.md参照）。RTSTRUCT書き出しは対象外のままブロック継続。
            new BlockedRoute(HttpMethod.POST, "/api/dicom/rtstruct"),
            new BlockedRoute(null, "/api/series/**"),
            new BlockedRoute(null, "/api/dbadmin/**"),
            new BlockedRoute(null, "/api/patients"),
            new BlockedRoute(null, "/api/patients/**"),
            new BlockedRoute(HttpMethod.DELETE, "/api/studies/**"),
            new BlockedRoute(HttpMethod.PUT, "/api/studies/**"),
            new BlockedRoute(HttpMethod.DELETE, "/api/instances/**"),
            new BlockedRoute(null, "/api/stats"),
            new BlockedRoute(null, "/api/system/**"),
            new BlockedRoute(null, "/api/imagej/**"),
            new BlockedRoute(HttpMethod.POST, "/api/plugins/*/run"),
            // 2026-07-14 追加: Export/SSRF/サーバー設定書き換え系の監査で発見したガード漏れ。
            // 参照: fw/web-demo-hosting.md「バックエンドガード漏れの追加監査」
            new BlockedRoute(null, "/api/export/**"),
            new BlockedRoute(null, "/api/series-extract/**"),
            new BlockedRoute(HttpMethod.POST, "/api/anonymizer/zip"),
            new BlockedRoute(HttpMethod.POST, "/api/anonymizer/copy"),
            new BlockedRoute(HttpMethod.POST, "/api/anonymizer/masks"),
            new BlockedRoute(HttpMethod.DELETE, "/api/anonymizer/masks"),
            new BlockedRoute(HttpMethod.POST, "/api/dicom/echo"),
            new BlockedRoute(HttpMethod.POST, "/api/dicom/tls-config"),
            new BlockedRoute(HttpMethod.PUT, "/api/settings")
    );

    private final AntPathMatcher matcher = new AntPathMatcher();

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        String path = request.getServletPath();
        HttpMethod method = HttpMethod.valueOf(request.getMethod());

        boolean blocked = BLOCKED.stream().anyMatch(route -> route.matches(method, path, matcher));
        if (blocked) {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/json");
            response.getWriter().write(
                    "{\"error\":\"この操作は公開デモでは無効化されています\"}");
            return;
        }
        chain.doFilter(request, response);
    }
}
