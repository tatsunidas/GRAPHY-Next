/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * 接続先の Jupyter Server（URL とトークン）。設計: fw/remote-compute-design.md §4.3。
 *
 * <p>🔴 <b>https 必須。平文 http は loopback と院内のプライベートアドレスだけ</b>
 * （`desktop/aiProviders.js` の {@code allowsPlainHttp} と同じ規則）。外へ出るのは
 * 匿名化済みとはいえ医用画像と任意のコードなので、インターネット越しの平文は認めない。
 *
 * <p>トークンは {@link #toString()} に出さない（ログに鍵を残さない）。
 *
 * @param base  サーバのベース URL（例 {@code https://gpu.example.org/user/a/}）。末尾の / は付けても付けなくてもよい
 * @param token Jupyter の API トークン。無認証のサーバなら null か空
 */
public record JupyterEndpoint(URI base, String token) {

    public JupyterEndpoint {
        if (base == null) {
            throw new IllegalArgumentException("base URL is required");
        }
        String scheme = base.getScheme() == null ? "" : base.getScheme().toLowerCase(Locale.ROOT);
        if (base.getHost() == null || base.getHost().isBlank()) {
            throw new IllegalArgumentException("base URL has no host: " + base);
        }
        if (base.getRawQuery() != null || base.getRawFragment() != null) {
            throw new IllegalArgumentException("base URL must not have a query or fragment");
        }
        if (base.getRawUserInfo() != null) {
            throw new IllegalArgumentException("base URL must not contain credentials");
        }
        if (scheme.equals("http")) {
            if (!allowsPlainHttp(base.getHost())) {
                throw new IllegalArgumentException(
                        "plain http is allowed only for loopback / private addresses: " + base.getHost());
            }
        } else if (!scheme.equals("https")) {
            throw new IllegalArgumentException("unsupported scheme: " + scheme);
        }
        String path = base.getRawPath() == null || base.getRawPath().isEmpty() ? "/" : base.getRawPath();
        if (!path.endsWith("/")) {
            path = path + "/";
        }
        base = URI.create(scheme + "://" + base.getRawAuthority() + path);
        token = token == null || token.isBlank() ? null : token.strip();
    }

    public static JupyterEndpoint of(String base, String token) {
        return new JupyterEndpoint(URI.create(base.strip()), token);
    }

    /** {@code api/...} のような相対パスを解決する（先頭に / を付けない）。 */
    public URI http(String relative) {
        return base.resolve(relative);
    }

    /** カーネルチャネルの WebSocket URL。 */
    public URI kernelChannels(String kernelId, String sessionId) {
        URI u = http("api/kernels/" + segment(kernelId) + "/channels?session_id="
                + URLEncoder.encode(sessionId, StandardCharsets.UTF_8).replace("+", "%20"));
        String ws = u.getScheme().equals("https") ? "wss" : "ws";
        return URI.create(ws + u.toString().substring(u.getScheme().length()));
    }

    /** {@code Authorization} ヘッダの値。トークンが無ければ null。 */
    public String authorization() {
        return token == null ? null : "token " + token;
    }

    @Override
    public String toString() {
        return "JupyterEndpoint[" + base + (token == null ? "" : ", token=***") + "]";
    }

    /** パスの 1 区切りを URL に入れられる形にする（/ を含めさせない）。 */
    static String segment(String s) {
        if (s == null || s.isEmpty() || s.equals(".") || s.equals("..") || s.contains("/") || s.contains("\\")) {
            throw new IllegalArgumentException("invalid path segment: " + s);
        }
        return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
    }

    /**
     * 平文 http を許す宛先か。
     *
     * <p>🔴 <b>{@code desktop/aiProviders.js} の {@code allowsPlainHttp} と同じ規則にする</b>
     * （接続先は main が検査してから backend へ渡す。規則がずれると「設定画面では通るのに
     * backend で弾かれる」になる）。許すのは: ループバック・RFC1918・単一ラベル名（社内名）・
     * {@code .local} {@code .internal} {@code .lan} {@code .home.arpa}・{@code .localhost}。
     * IPv6 は {@code ::1} だけ。公開 IP とそれ以外の名前は許さない。名前解決はしない。
     */
    static boolean allowsPlainHttp(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) {
            h = h.substring(1, h.length() - 1);
        }
        if (h.isEmpty()) {
            return false;
        }
        if (h.equals("localhost") || h.equals("::1") || h.equals("127.0.0.1") || h.endsWith(".localhost")) {
            return true;
        }
        java.util.regex.Matcher m = IPV4.matcher(h);
        if (m.matches()) {
            int a = Integer.parseInt(m.group(1));
            int b = Integer.parseInt(m.group(2));
            return a == 127 || a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168);
        }
        if (h.matches("[0-9a-f:]+")) {
            return false; // ::1 以外の IPv6 リテラル
        }
        if (!h.contains(".")) {
            return true; // 単一ラベル＝社内名
        }
        return h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa");
    }

    private static final java.util.regex.Pattern IPV4 =
            java.util.regex.Pattern.compile("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})");
}
