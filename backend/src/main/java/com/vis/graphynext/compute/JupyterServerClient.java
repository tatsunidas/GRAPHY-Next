/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * Jupyter Server の REST（{@code /api/status} {@code /api/kernels} {@code /api/contents}）と、
 * カーネルへの WebSocket（{@link KernelChannel}）の入口。設計: fw/remote-compute-design.md §6。
 *
 * <p>JDK の {@code java.net.http} だけを使い、外部依存を足さない（{@code HttpGitHubReleaseClient} と同じ）。
 *
 * <p>🔴 <b>リダイレクトは追わない。</b> 追うと、登録した接続先とは別の host へトークン付きで
 * 要求が飛びうる（宛先を登録済みの host に限る、という規則 §4.3 が崩れる）。
 *
 * <p>この段（段 1）では Spring の bean にしない。接続先の登録・トークンの受け渡し・同意を
 * 足す段 2 以降で、それらを通した呼び出し口だけを公開する。
 */
public final class JupyterServerClient {

    /** Contents API で 1 回に送る大きさ（base64 にする前のバイト数）。 */
    static final int UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
    /** ダウンロードの上限。Contents API は 1 回の JSON で丸ごと返すので、ここで抑える。 */
    static final long MAX_DOWNLOAD_BYTES = 512L * 1024 * 1024;

    /**
     * ダウンロードの応答を読むためのもの。中身は base64 の文字列 1 本で、Jackson の既定の上限（1 文字列 2000 万字
     * ＝約 15 MB のファイル）をすぐ超える（512×512×66 の uint8 ラベルで実際に超えた）。上限は受け取れる大きさに合わせる。
     */
    private static final ObjectMapper DOWNLOAD_MAPPER = new ObjectMapper(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder()
                    .maxStringLength((int) Math.min(Integer.MAX_VALUE, MAX_DOWNLOAD_BYTES * 4 / 3 + 4096))
                    .build())
            .build());

    private final JupyterEndpoint ep;
    private final ObjectMapper mapper;
    private final HttpClient http;
    private final Duration requestTimeout;

    public JupyterServerClient(JupyterEndpoint ep, ObjectMapper mapper) {
        this(ep, mapper, Duration.ofSeconds(60));
    }

    public JupyterServerClient(JupyterEndpoint ep, ObjectMapper mapper, Duration requestTimeout) {
        this.ep = ep;
        this.mapper = mapper;
        this.requestTimeout = requestTimeout;
        this.http = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    public JupyterEndpoint endpoint() {
        return ep;
    }

    /** サーバが生きているか・トークンが通るか（接続テスト用）。{@code /api/status} の中身を返す。 */
    public JsonNode status() {
        return json(send(get("api/status"), 200));
    }

    /** サーバの版（{@code GET /api}）。分からなければ null。 */
    public String version() {
        return json(send(get("api"), 200)).path("version").asText(null);
    }

    /** 使えるカーネルの種類。{@code {default, kernelspecs:{name:{spec:{display_name, language}}}}}。 */
    public JsonNode kernelSpecs() {
        return json(send(get("api/kernelspecs"), 200));
    }

    /**
     * カーネルを起動して id を返す。{@code name} が null ならサーバの既定。
     *
     * <p>🔴 <b>{@code path} に Contents の根（空文字）を必ず渡す。</b> 渡さないと jupyter_server は
     * カーネルを<b>サーバのプロセスの作業フォルダ</b>で起動し、{@link #upload} で置いたファイルが
     * 相対パスで見えない（実測 2026-10-02・jupyter_server 2.10）。
     */
    public String startKernel(String name) {
        return startKernel(name, "");
    }

    /**
     * {@code path}（Contents の根からの相対フォルダ）を作業フォルダにしてカーネルを起動する。
     * ジョブはここに {@code inputs/} {@code outputs/} を置き、コードは相対パスで読み書きする。
     */
    public String startKernel(String name, String path) {
        String p = path == null || path.isBlank() ? "" : String.join("/", segments(path));
        ObjectNode body = mapper.createObjectNode().put("path", p);
        if (name != null) {
            body.put("name", name);
        }
        JsonNode k = json(send(post("api/kernels", body), 201, 200));
        String id = k.path("id").asText(null);
        if (id == null) {
            throw new JupyterException("server returned no kernel id", 0);
        }
        return id;
    }

    /** カーネルの状態（{@code execution_state} 等）。無ければ null。 */
    public JsonNode kernel(String kernelId) {
        HttpResponse<byte[]> r = send(get("api/kernels/" + JupyterEndpoint.segment(kernelId)), 200, 404);
        return r.statusCode() == 404 ? null : json(r);
    }

    public void interruptKernel(String kernelId) {
        send(post("api/kernels/" + JupyterEndpoint.segment(kernelId) + "/interrupt", mapper.createObjectNode()),
                204, 200);
    }

    /** カーネルを止める。もう無ければ何もしない。 */
    public void shutdownKernel(String kernelId) {
        send(builder("api/kernels/" + JupyterEndpoint.segment(kernelId)).DELETE().build(), 204, 200, 404);
    }

    /** カーネルへの WebSocket を開き、応答するまで待つ。 */
    public KernelChannel connect(String kernelId, Duration readyTimeout) {
        KernelChannel ch = KernelChannel.open(http, mapper, ep, kernelId, Duration.ofSeconds(15));
        try {
            ch.awaitReady(readyTimeout);
        } catch (RuntimeException e) {
            ch.close();
            throw e;
        }
        return ch;
    }

    /** フォルダを作る（親も順に作る）。既にあれば何もしない。 */
    public void mkdirs(String path) {
        StringBuilder cur = new StringBuilder();
        for (String seg : segments(path)) {
            if (!cur.isEmpty()) {
                cur.append('/');
            }
            cur.append(seg);
            String p = cur.toString();
            if (send(get(contents(p) + "?content=0"), 200, 404).statusCode() == 404) {
                ObjectNode body = mapper.createObjectNode().put("type", "directory");
                send(put(contents(p), body), 201, 200);
            }
        }
    }

    /**
     * ファイルを置く（上書き）。大きいものは Contents API の {@code chunk} で分けて送る
     * （jupyter_server の LargeFileManager が受ける。1 番目で作り、続きを足し、-1 で閉じる）。
     */
    public void upload(String path, byte[] data) {
        List<String> segs = segments(path);
        if (segs.size() > 1) {
            mkdirs(String.join("/", segs.subList(0, segs.size() - 1)));
        }
        String uri = contents(String.join("/", segs));
        String name = segs.get(segs.size() - 1);
        if (data.length <= UPLOAD_CHUNK_BYTES) {
            send(put(uri, fileBody(name, data, 0, data.length, null)), 201, 200);
            return;
        }
        int chunk = 1;
        for (int off = 0; off < data.length; off += UPLOAD_CHUNK_BYTES, chunk++) {
            int len = Math.min(UPLOAD_CHUNK_BYTES, data.length - off);
            boolean last = off + len >= data.length;
            send(put(uri, fileBody(name, data, off, len, last ? -1 : chunk)), 201, 200);
        }
    }

    /** ファイルを取ってくる。無ければ null。 */
    public byte[] download(String path) {
        String uri = contents(String.join("/", segments(path)));
        HttpResponse<byte[]> r = send(get(uri + "?type=file&format=base64&content=1"), 200, 404);
        if (r.statusCode() == 404) {
            return null;
        }
        if (r.body().length > MAX_DOWNLOAD_BYTES * 4 / 3 + 4096) {
            throw new JupyterException("file too large to download: " + path, 0);
        }
        JsonNode m;
        try {
            m = DOWNLOAD_MAPPER.readTree(r.body());
        } catch (IOException e) {
            throw new JupyterException("unparsable response from " + path(r.request()) + ": " + e.getMessage(), e);
        }
        String content = m.path("content").asText(null);
        if (content == null) {
            throw new JupyterException("not a file: " + path, 0);
        }
        return Base64.getMimeDecoder().decode(content);
    }

    /** フォルダの中身（名前と種類）。無ければ空。 */
    public List<JsonNode> list(String path) {
        String p = path == null || path.isBlank() ? "" : String.join("/", segments(path));
        HttpResponse<byte[]> r = send(get(contents(p) + "?content=1"), 200, 404);
        List<JsonNode> out = new ArrayList<>();
        if (r.statusCode() == 404) {
            return out;
        }
        json(r).path("content").forEach(out::add);
        return out;
    }

    /**
     * ファイルかフォルダを消す（フォルダは中身ごと）。無ければ何もしない。
     *
     * <p>Contents API は中身のあるフォルダの削除を 400 で断る（ゴミ箱に送る設定のときを除く）ので、
     * 中から順に消す。
     */
    public void delete(String path) {
        String p = String.join("/", segments(path));
        HttpResponse<byte[]> meta = send(get(contents(p) + "?content=0"), 200, 404);
        if (meta.statusCode() == 404) {
            return;
        }
        if ("directory".equals(json(meta).path("type").asText())) {
            for (JsonNode child : list(p)) {
                delete(p + "/" + child.path("name").asText());
            }
        }
        send(builder(contents(p)).DELETE().build(), 204, 200, 404);
    }

    // --- 以下は内部 ---

    private ObjectNode fileBody(String name, byte[] data, int off, int len, Integer chunk) {
        byte[] part = off == 0 && len == data.length ? data : java.util.Arrays.copyOfRange(data, off, off + len);
        ObjectNode b = mapper.createObjectNode()
                .put("type", "file")
                .put("format", "base64")
                .put("name", name)
                .put("content", Base64.getEncoder().encodeToString(part));
        if (chunk != null) {
            b.put("chunk", chunk);
        }
        return b;
    }

    /** {@code a/b/c} を区切りごとに確かめる（{@code ..} や空の区切りで外へ出させない）。 */
    static List<String> segments(String path) {
        if (path == null || path.isBlank()) {
            throw new IllegalArgumentException("path is required");
        }
        List<String> out = new ArrayList<>();
        for (String s : path.replace('\\', '/').split("/")) {
            if (s.isEmpty()) {
                continue;
            }
            JupyterEndpoint.segment(s); // . / .. を弾く
            out.add(s);
        }
        if (out.isEmpty()) {
            throw new IllegalArgumentException("path is required");
        }
        return out;
    }

    private static String contents(String path) {
        StringBuilder sb = new StringBuilder("api/contents");
        if (!path.isEmpty()) {
            for (String s : path.split("/")) {
                sb.append('/').append(JupyterEndpoint.segment(s));
            }
        }
        return sb.toString();
    }

    private HttpRequest.Builder builder(String relative) {
        URI u = ep.http(relative);
        HttpRequest.Builder b = HttpRequest.newBuilder(u).timeout(requestTimeout)
                .header("Accept", "application/json");
        ep.headers().forEach(b::header);
        return b;
    }

    private HttpRequest get(String relative) {
        return builder(relative).GET().build();
    }

    private HttpRequest post(String relative, JsonNode body) {
        return builder(relative).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body.toString())).build();
    }

    private HttpRequest put(String relative, JsonNode body) {
        return builder(relative).header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(body.toString())).build();
    }

    private HttpResponse<byte[]> send(HttpRequest req, int... ok) {
        HttpResponse<byte[]> r;
        try {
            r = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
        } catch (IOException e) {
            throw new JupyterException(req.method() + " " + path(req) + " failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new JupyterException("interrupted", e);
        }
        for (int s : ok) {
            if (r.statusCode() == s) {
                return r;
            }
        }
        throw new JupyterException(req.method() + " " + path(req) + " -> HTTP " + r.statusCode()
                + describe(r), r.statusCode());
    }

    /** エラー時に URL を出すがトークンは出さない（ヘッダにしか載せていないので path だけで足りる）。 */
    private static String path(HttpRequest req) {
        return req.uri().getRawPath();
    }

    private String describe(HttpResponse<byte[]> r) {
        if (r.statusCode() == 401 || r.statusCode() == 403) {
            return " (token rejected?)";
        }
        if (r.statusCode() >= 300 && r.statusCode() < 400) {
            return " (redirect not followed: " + r.headers().firstValue("Location").orElse("?") + ")";
        }
        try {
            String msg = mapper.readTree(r.body()).path("message").asText("");
            return msg.isEmpty() ? "" : " (" + (msg.length() > 200 ? msg.substring(0, 200) : msg) + ")";
        } catch (IOException e) {
            return "";
        }
    }

    private JsonNode json(HttpResponse<byte[]> r) {
        try {
            return mapper.readTree(r.body());
        } catch (IOException e) {
            throw new JupyterException("unparsable response from " + path(r.request()) + ": " + e.getMessage(), e);
        }
    }
}
