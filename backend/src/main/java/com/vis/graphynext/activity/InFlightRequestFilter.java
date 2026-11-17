/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

import java.io.IOException;
import java.util.List;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 要求が返るまで続く「変更を伴う処理」を {@link InFlightRequests} に数える。
 * 対象はここに挙げた経路の POST/PUT/PATCH/DELETE だけ（GET と、すぐ返る要求は数えない）。
 * ジョブ ID を持つ処理（取り込み・エクスポートなど）は、各 Service が {@link ActiveWork} で持つ。
 */
@Component
public class InFlightRequestFilter extends OncePerRequestFilter {

    /** exact: そのパスだけ（前方一致にすると、すぐ返るジョブの投入・中止まで数える）。 */
    private record Route(String path, String kind, boolean exact) {
        static Route prefix(String path, String kind) {
            return new Route(path, kind, false);
        }

        static Route exact(String path, String kind) {
            return new Route(path, kind, true);
        }

        boolean matches(String uri) {
            return exact ? uri.equals(path) : uri.startsWith(path);
        }
    }

    /**
     * 先に一致したものを使う。種類のキーは desktop/quitMessages.js の文言表に載せること
     * （desktop の試験が、ここの文字列と表の食い違いを検出する）。
     */
    private static final List<Route> ROUTES = List.of(
            Route.prefix("/api/dicom/send", "send"),
            Route.prefix("/api/dicom/qr/get", "qrGetMove"),
            Route.prefix("/api/dicom/qr/move", "qrGetMove"),
            Route.prefix("/api/db-transfer", "dbTransfer"),
            Route.prefix("/api/anonymizer/zip", "anonymizeRun"),
            Route.prefix("/api/anonymizer/copy", "anonymizeRun"),
            Route.prefix("/api/export/zip", "exportRun"),
            Route.prefix("/api/nifti/export", "exportRun"),
            Route.prefix("/api/series-extract/zip", "seriesExtractRun"),
            Route.prefix("/api/series-extract/copy", "seriesExtractRun"),
            Route.prefix("/api/series-extract/verify", "seriesExtractRun"),
            Route.prefix("/api/series-extract/datasheet", "seriesExtractRun"),
            Route.exact("/api/import/paths", "importRun"),
            Route.prefix("/api/import/nondicom", "importRun"),
            Route.prefix("/api/nifti/import", "importRun"),
            Route.prefix("/api/raw/import", "importRun"),
            Route.prefix("/api/microscopy/import", "importRun"),
            Route.prefix("/api/imagej/import", "importRun"),
            Route.prefix("/api/prefetch/run", "prefetchRun"),
            Route.prefix("/api/emr/prefetch", "prefetchRun"),
            Route.prefix("/api/radiomics/glam/analyze", "analysisRun"),
            Route.prefix("/api/radiomics/features/max-section", "analysisRun"),
            Route.exact("/api/series/texture", "analysisRun"),
            Route.prefix("/api/series/derived", "analysisRun"),
            Route.prefix("/api/dbadmin/", "dbEdit"),
            Route.prefix("/api/patients", "dbEdit"),
            Route.prefix("/api/instances", "dbEdit"),
            Route.prefix("/api/reports", "reportSave"));

    private final InFlightRequests inFlight;

    /** Spring が使う。フィルターは @WebMvcTest のスライスにも入るので、他の Bean に依存させない。 */
    public InFlightRequestFilter() {
        this(new InFlightRequests());
    }

    InFlightRequestFilter(InFlightRequests inFlight) {
        this.inFlight = inFlight;
    }

    /** 数えている実体（ActivityService が読む）。 */
    InFlightRequests tracker() {
        return inFlight;
    }

    /** 数える種類。数えない要求は null。 */
    static String kindOf(String method, String uri) {
        if (method == null || "GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method)) return null;
        // シリーズごとの事前取得（POST /api/studies/{uid}/series/{uid}/prefetch）は、DB 編集より先に分ける
        if (uri.endsWith("/prefetch")) return "prefetchRun";
        // DB の編集は、実際にあるパスと動詞の組だけ（前方一致にすると、ジョブの投入・中止まで数える）
        boolean edits = "PUT".equals(method) || "DELETE".equals(method);
        if (edits && uri.startsWith("/api/studies/")) return "dbEdit"; // 削除・患者情報の変更
        if ("DELETE".equals(method) && uri.matches("/api/series/[^/]+/[^/]+")) return "dbEdit";
        for (Route r : ROUTES) {
            if (r.matches(uri)) return r.kind();
        }
        return null;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String kind = kindOf(request.getMethod(), request.getRequestURI());
        if (kind == null) {
            chain.doFilter(request, response);
            return;
        }
        inFlight.enter(kind);
        try {
            chain.doFilter(request, response);
        } finally {
            inFlight.exit(kind);
        }
    }
}
