/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import com.vis.graphynext.web.RateLimitFilter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.time.Clock;

/**
 * 共有リンクの入口 {@code GET /s/{token}}。トークンが URL に載るのはここだけ。
 *
 * <p>成功したら閲覧セッション Cookie（HttpOnly・SameSite=Lax、https のときは Secure）を付けて画面へ 302。
 * 失敗は<b>理由を区別せず 404</b>。失敗は IP ごとに数え、上限を超えたら 429（トークンの当てずっぽうを止める）。
 * 🔴 トークンをログ・例外メッセージに出さない（このクラスは例外を投げず、自分で応答する）。
 */
@RestController
@ConditionalOnProperty(prefix = "graphy.share", name = "enabled", havingValue = "true")
public class ShareEntryController {

    private static final String INVALID_PAGE = "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\">"
            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>GRAPHY-Next</title></head>"
            + "<body style=\"font-family:system-ui,sans-serif;margin:2rem;line-height:1.6\">"
            + "<p>このリンクは無効か、期限が切れています。送信元に新しいリンクを依頼してください。</p>"
            + "<p>This link is invalid or has expired. Please ask the sender for a new link.</p></body></html>";

    private final ShareService service;
    private final FailureLimiter limiter;

    public ShareEntryController(ShareService service, ShareProperties props) {
        this.service = service;
        this.limiter = new FailureLimiter(props.getFailuresPerMinute(), Clock.systemUTC());
    }

    @GetMapping("/s/{token}")
    public ResponseEntity<String> enter(@PathVariable String token, HttpServletRequest request,
            HttpServletResponse response) {
        String ip = RateLimitFilter.clientIp(request);
        if (limiter.blocked(ip)) {
            return ResponseEntity.status(429).header("Retry-After", "60").body("{\"error\":\"too many requests\"}");
        }
        ShareGrant grant = service.redeem(token).orElse(null);
        if (grant == null) {
            limiter.recordFailure(ip);
            // ブラウザで開かれた無効リンクに生の JSON を見せない。状態は 404 のまま（理由は区別しない）。
            if (wantsHtml(request)) {
                return ResponseEntity.status(404).contentType(MediaType.TEXT_HTML).body(INVALID_PAGE);
            }
            return ResponseEntity.status(404).body("{\"error\":\"not found\"}");
        }
        StringBuilder cookie = new StringBuilder(ShareAccessFilter.COOKIE_NAME).append('=')
                .append(service.sessionCookie(grant))
                .append("; Max-Age=").append(service.sessionMaxAgeSeconds(grant))
                .append("; Path=/; HttpOnly; SameSite=Lax");
        if (request.isSecure()) {
            cookie.append("; Secure");
        }
        return ResponseEntity.status(302).header("Set-Cookie", cookie.toString()).header("Location", "/#share").build();
    }

    private static boolean wantsHtml(HttpServletRequest request) {
        String accept = request.getHeader("Accept");
        return accept != null && accept.contains("text/html");
    }
}
