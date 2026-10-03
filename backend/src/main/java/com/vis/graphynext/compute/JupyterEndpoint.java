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
 * @param token Jupyter の API トークン（Colab ならランタイムの接続トークン）。無認証のサーバなら null か空
 * @param auth  トークンの渡し方
 */
public record JupyterEndpoint(URI base, String token, Auth auth) {

    /**
     * トークンの渡し方。
     * <ul>
     *   <li>{@code JUPYTER}: {@code Authorization: token <token>}（普通の Jupyter Server）</li>
     *   <li>{@code COLAB}: {@code X-Colab-Runtime-Proxy-Token: <token>}（Colab のランタイム。トークンは約 1 時間で
     *       切れるので main が GetRuntime で取り直して入れ直す。fw/remote-compute-design.md §15）</li>
     * </ul>
     */
    public enum Auth { JUPYTER, COLAB }

    /** Colab へ名乗るクライアント名（{@code X-Colab-Client-Agent}）。 */
    static final String COLAB_CLIENT_AGENT = "graphy-next";

    public JupyterEndpoint(URI base, String token) {
        this(base, token, Auth.JUPYTER);
    }

    public JupyterEndpoint {
        auth = auth == null ? Auth.JUPYTER : auth;
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

    public static JupyterEndpoint of(String base, String token, Auth auth) {
        return new JupyterEndpoint(URI.create(base.strip()), token, auth);
    }

    /**
     * 要求に付けるヘッダ（HTTP と WebSocket の両方）。トークンが無ければ空。
     */
    public java.util.Map<String, String> headers() {
        java.util.Map<String, String> h = new java.util.LinkedHashMap<>();
        if (auth == Auth.COLAB) {
            h.put("X-Colab-Client-Agent", COLAB_CLIENT_AGENT);
            if (token != null) {
                h.put("X-Colab-Runtime-Proxy-Token", token);
            }
        } else if (token != null) {
            h.put("Authorization", "token " + token);
        }
        return h;
    }

    /**
     * ジョブのフォルダを置く場所（Contents の根からの相対）。Colab は Contents の根が OS の根（{@code /}）なので
     * 作業用の {@code content/} の下に置く（実測 2026-10-03）。
     */
    public String workRoot() {
        return auth == Auth.COLAB ? "content/graphy" : "graphy";
    }

    /**
     * カーネルの中から見た Contents の根（絶対パス）。分かっていれば、ジョブの前に作業フォルダへ chdir する。
     *
     * <p>🔴 <b>Colab はカーネルの起動時の {@code path} を無視する</b>（実測 2026-10-03: {@code inputs/0.npz} が
     * 見つからなかった）。Contents の根は {@code /} と分かっているので、本体の固定コードで移る。
     * 普通の Jupyter Server は {@code path} が効くので null（根の絶対パスはサーバの設定次第で分からない）。
     */
    public String contentsRootInKernel() {
        return auth == Auth.COLAB ? "/" : null;
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

    /** {@code Authorization} ヘッダの値（{@code JUPYTER} のとき）。無ければ null。 */
    public String authorization() {
        return headers().get("Authorization");
    }

    @Override
    public String toString() {
        return "JupyterEndpoint[" + base + ", " + auth + (token == null ? "" : ", token=***") + "]";
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
