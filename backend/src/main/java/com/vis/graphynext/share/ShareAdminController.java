/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import com.vis.graphynext.web.RateLimitFilter;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 共有リンクの発行・一覧・取り消し。{@code Authorization: Bearer <graphy.share.admin-key>} が要る。
 * 鍵が無い・違うは 401。失敗は IP ごとに数え、上限を超えたら 429。
 * 発行の応答だけが生トークン（と、公開ベース URL があればリンク）を返す。一覧にはハッシュも生トークンも出ない。
 */
@RestController
@RequestMapping(ShareAccessFilter.ADMIN_PATH)
@ConditionalOnProperty(prefix = "graphy.share", name = "enabled", havingValue = "true")
public class ShareAdminController {

    public record IssueRequest(Set<String> studyUids, Integer ttlDays) {
    }

    private final ShareService service;
    private final ShareProperties props;
    private final FailureLimiter limiter;

    public ShareAdminController(ShareService service, ShareProperties props) {
        this.service = service;
        this.props = props;
        this.limiter = new FailureLimiter(props.getFailuresPerMinute(), Clock.systemUTC());
    }

    @PostMapping
    public ResponseEntity<?> issue(@RequestBody IssueRequest body, HttpServletRequest request) {
        ResponseEntity<?> denied = authorize(request);
        if (denied != null) {
            return denied;
        }
        ShareService.Issued issued;
        try {
            issued = service.issue(body.studyUids() == null ? null : new LinkedHashSet<>(body.studyUids()),
                    body.ttlDays());
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
        String path = "/s/" + issued.rawToken();
        String base = props.getPublicBaseUrl();
        return ResponseEntity.status(201).body(Map.of(
                "id", issued.grant().getId(),
                "expiresAt", issued.grant().getExpiresAt().toString(),
                "path", path,
                "url", base == null || base.isBlank() ? path : base.replaceAll("/+$", "") + path));
    }

    @GetMapping
    public ResponseEntity<?> list(HttpServletRequest request) {
        ResponseEntity<?> denied = authorize(request);
        if (denied != null) {
            return denied;
        }
        Instant now = Instant.now();
        List<Map<String, Object>> rows = service.list().stream().map(g -> Map.<String, Object>of(
                "id", g.getId(),
                "studyUids", g.getStudyUids(),
                "createdAt", g.getCreatedAt().toString(),
                "expiresAt", g.getExpiresAt().toString(),
                "status", g.getRevokedAt() != null ? "revoked" : (g.isActiveAt(now) ? "active" : "expired"))).toList();
        return ResponseEntity.ok(rows);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> revoke(@PathVariable String id, HttpServletRequest request) {
        ResponseEntity<?> denied = authorize(request);
        if (denied != null) {
            return denied;
        }
        return service.revoke(id) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    /** 通れば null、通れなければ返す応答。鍵の比較は定数時間。 */
    private ResponseEntity<?> authorize(HttpServletRequest request) {
        String ip = RateLimitFilter.clientIp(request);
        if (limiter.blocked(ip)) {
            return ResponseEntity.status(429).header("Retry-After", "60").body(Map.of("error", "too many requests"));
        }
        String header = request.getHeader("Authorization");
        String given = header != null && header.startsWith("Bearer ") ? header.substring(7) : "";
        if (!MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8),
                props.getAdminKey().getBytes(StandardCharsets.UTF_8))) {
            limiter.recordFailure(ip);
            return ResponseEntity.status(401).body(Map.of("error", "unauthorized"));
        }
        return null;
    }
}
