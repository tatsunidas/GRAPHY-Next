/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * {@code /api/internal/**} を <b>Electron main だけ</b>に開く。設計: fw/remote-compute-design.md §4.1。
 *
 * <p>なぜ要るのか: レンダラ（＝同じ realm に入るプラグインも）は backend の API を自由に叩ける。
 * 接続先のトークンを受け取る口・送信の承認を受け取る口をレンダラから叩けたら、
 * main が描く確認ダイアログも safeStorage も意味がなくなる。
 *
 * <p>main は backend を起動するとき、起動ごとの乱数を環境変数 {@code GRAPHY_MAIN_SECRET} で渡す。
 * レンダラはこの値を知らない（preload にも渡さない）。ここで確かめるのは 3 つ:
 * <ol>
 *   <li>{@code Authorization: Bearer <secret>} が一致する（定数時間で比べる）</li>
 *   <li>送信元が loopback</li>
 *   <li>{@code Origin} ヘッダが無い（main の Node は付けない。ブラウザ・レンダラからの要求は付けうる）</li>
 * </ol>
 * どれかが欠けたら <b>404</b> を返す（口の存在を教えない）。secret が渡されていない
 * （web モード・main を通さず起動した backend）なら、この口は丸ごと無い。
 */
@Component
public class MainChannelFilter extends OncePerRequestFilter {

    static final String PREFIX = "/api/internal/";
    /** 短すぎる secret は受け付けない（誤設定で総当たりできる口を作らない）。 */
    static final int MIN_SECRET_CHARS = 32;

    private final byte[] secret;

    public MainChannelFilter(@Value("${GRAPHY_MAIN_SECRET:}") String secret) {
        String s = secret == null ? "" : secret.strip();
        this.secret = s.length() >= MIN_SECRET_CHARS ? s.getBytes(StandardCharsets.UTF_8) : null;
    }

    /** main との経路が使えるか（secret が渡されているか）。 */
    public boolean enabled() {
        return secret != null;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith(PREFIX);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (allowed(request)) {
            chain.doFilter(request, response);
            return;
        }
        response.sendError(HttpServletResponse.SC_NOT_FOUND);
    }

    boolean allowed(HttpServletRequest request) {
        if (secret == null) {
            return false;
        }
        if (request.getHeader("Origin") != null) {
            return false;
        }
        if (!isLoopback(request.getRemoteAddr())) {
            return false;
        }
        String auth = request.getHeader("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")) {
            return false;
        }
        byte[] given = auth.substring("Bearer ".length()).strip().getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(secret, given);
    }

    private static boolean isLoopback(String addr) {
        if (addr == null || addr.isBlank()) {
            return false;
        }
        try {
            return InetAddress.getByName(addr).isLoopbackAddress(); // getRemoteAddr は IP リテラル
        } catch (UnknownHostException e) {
            return false;
        }
    }
}
