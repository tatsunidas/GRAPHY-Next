/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.function.Consumer;
import java.util.function.Function;

import static com.vis.graphynext.gdrive.GdriveException.Kind;

/**
 * Drive v3 の必要最小限。JDK の {@link HttpClient}（リダイレクトは追わない）。
 *
 * <p>{@code drive.file} では、アプリが作ったフォルダ・ファイルしか見えない。ここで扱うのは
 * 「選ばれた親の直下にアプリが作った {@code GRAPHY-DB-…} フォルダ」の中だけ。
 * 共有ドライブでも動くよう {@code supportsAllDrives=true} を常に付ける。
 */
public class DriveClient {

    /** 256 KiB の倍数（resumable の要件）。 */
    static final int CHUNK = 8 * 1024 * 1024;
    static final String FOLDER_MIME = "application/vnd.google-apps.folder";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** md5 は Drive が返す小文字 16 進。フォルダには無い。 */
    public record RemoteFile(String id, String name, String md5, long size) {
    }

    private final HttpClient http;
    private final String apiBase;
    private final GdriveTokenSource tokens;

    /** @param apiBase 例 {@code https://www.googleapis.com}（末尾の / なし）。テストでは偽サーバに差し替える。 */
    public DriveClient(HttpClient http, String apiBase, GdriveTokenSource tokens) {
        this.http = http;
        this.apiBase = apiBase.endsWith("/") ? apiBase.substring(0, apiBase.length() - 1) : apiBase;
        this.tokens = tokens;
    }

    // ── 検索・フォルダ ──────────────────────────────────────────────

    /** 親の直下の、同じ名前のフォルダ（ゴミ箱を除く）を探し、無ければ作る。 */
    public String ensureFolder(String parentId, String name) throws GdriveException {
        Optional<RemoteFile> f = findByName(parentId, name, true);
        if (f.isPresent()) {
            return f.get().id();
        }
        ObjectNode meta = JSON.createObjectNode().put("name", name).put("mimeType", FOLDER_MIME);
        meta.putArray("parents").add(parentId);
        HttpResponse<byte[]> r = exec(t -> request(api("/files?supportsAllDrives=true&fields=id"), t)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(meta.toString())).build());
        return parse(r).path("id").asText();
    }

    public Optional<RemoteFile> findByName(String parentId, String name, boolean folder) throws GdriveException {
        String q = "name='" + esc(name) + "' and '" + esc(parentId) + "' in parents and trashed=false"
                + (folder ? " and mimeType='" + FOLDER_MIME + "'" : " and mimeType!='" + FOLDER_MIME + "'");
        List<RemoteFile> l = list(q, 2);
        return l.isEmpty() ? Optional.empty() : Optional.of(l.get(0));
    }

    /** 親の直下のファイル（フォルダを除く）をすべて。 */
    public List<RemoteFile> listFiles(String parentId) throws GdriveException {
        return list("'" + esc(parentId) + "' in parents and trashed=false and mimeType!='" + FOLDER_MIME + "'", 1000);
    }

    private List<RemoteFile> list(String q, int pageSize) throws GdriveException {
        List<RemoteFile> out = new ArrayList<>();
        String page = null;
        do {
            String url = "/files?supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=" + pageSize
                    + "&fields=" + enc("nextPageToken,files(id,name,md5Checksum,size)")
                    + "&q=" + enc(q) + (page == null ? "" : "&pageToken=" + enc(page));
            HttpResponse<byte[]> r = exec(t -> request(api(url), t).GET().build());
            JsonNode n = parse(r);
            for (JsonNode f : n.path("files")) {
                out.add(new RemoteFile(f.path("id").asText(), f.path("name").asText(),
                        f.path("md5Checksum").asText(null), f.path("size").asLong(0)));
            }
            page = n.path("nextPageToken").asText(null);
            if (pageSize <= 2) {
                break; // 名前検索は先頭だけで足りる
            }
        } while (page != null);
        return out;
    }

    /** ゴミ箱へ移す（完全削除はしない）。既に無ければ成功扱い。 */
    public void trash(String fileId) throws GdriveException {
        try {
            HttpResponse<byte[]> r = exec(t -> request(api("/files/" + enc(fileId) + "?supportsAllDrives=true&fields=id"), t)
                    .header("Content-Type", "application/json")
                    .method("PATCH", HttpRequest.BodyPublishers.ofString("{\"trashed\":true}")).build());
            parse(r);
        } catch (GdriveException e) {
            if (e.kind() != Kind.NOT_FOUND) {
                throw e;
            }
        }
    }

    // ── アップロード（resumable） ──────────────────────────────────

    /**
     * 中断から再開できるアップロード。{@code existingId} があれば内容の更新、無ければ新規作成。
     * {@code sessionUri} は前回の途中のもの（無ければ null）。取れた／作ったセッションは {@code sessionSink} に通知する
     * （呼び出し側が台帳に残し、プロセスが落ちても続きから再開できる）。
     *
     * @return 完了後の Drive 上のファイル（md5 付き）
     */
    public RemoteFile upload(Path file, String name, String parentId, String existingId, String sessionUri,
                             Consumer<String> sessionSink) throws GdriveException {
        long total;
        try {
            total = java.nio.file.Files.size(file);
        } catch (IOException e) {
            throw new GdriveException(Kind.FATAL, "local-unreadable", e);
        }
        String session = sessionUri;
        long offset = 0;
        if (session != null) {
            Long o = queryOffset(session, total);
            if (o == null) {
                session = null; // 期限切れ・失効。新しく始める
            } else if (o < 0) {
                return finishFromQuery(session, total);
            } else {
                offset = o;
            }
        }
        if (session == null) {
            session = startSession(name, parentId, existingId, total);
            sessionSink.accept(session);
        }
        try (FileChannel ch = FileChannel.open(file, StandardOpenOption.READ)) {
            while (true) {
                int len = (int) Math.min(CHUNK, total - offset);
                ByteBuffer buf = ByteBuffer.allocate(len);
                ch.position(offset);
                while (buf.hasRemaining() && ch.read(buf) >= 0) {
                    // 読み切るまで
                }
                byte[] bytes = buf.array();
                final String sess = session;
                final long off = offset;
                HttpResponse<byte[]> r = execAbsolute(sess, b -> {
                    if (total > 0) {
                        b.header("Content-Range", "bytes " + off + "-" + (off + len - 1) + "/" + total);
                    }
                    return b.PUT(HttpRequest.BodyPublishers.ofByteArray(bytes));
                });
                if (r.statusCode() == 308) {
                    offset = nextOffset(r);
                    continue;
                }
                if (r.statusCode() == 200 || r.statusCode() == 201) {
                    return fileOf(parse(r));
                }
                if (r.statusCode() == 404 || r.statusCode() == 410) {
                    sessionSink.accept(null);
                    throw new GdriveException(Kind.RETRY, r.statusCode(), "upload-session-expired");
                }
                throw error(r);
            }
        } catch (IOException e) {
            throw new GdriveException(Kind.OFFLINE, "upload-io", e);
        }
    }

    private String startSession(String name, String parentId, String existingId, long total) throws GdriveException {
        ObjectNode meta = JSON.createObjectNode().put("name", name);
        if (existingId == null) {
            meta.putArray("parents").add(parentId);
        }
        String path = "/files" + (existingId == null ? "" : "/" + enc(existingId))
                + "?uploadType=resumable&supportsAllDrives=true&fields=" + enc("id,name,md5Checksum,size");
        HttpResponse<byte[]> r = exec(t -> request(upload(path), t)
                .header("Content-Type", "application/json; charset=UTF-8")
                .header("X-Upload-Content-Length", String.valueOf(total))
                .method(existingId == null ? "POST" : "PATCH", HttpRequest.BodyPublishers.ofString(meta.toString())).build());
        if (r.statusCode() != 200) {
            throw error(r);
        }
        String loc = r.headers().firstValue("Location").orElse(null);
        if (loc == null) {
            throw new GdriveException(Kind.RETRY, r.statusCode(), "upload-session-no-location");
        }
        return loc;
    }

    /** 受け取り済みのバイト数。-1＝すでに完了している。null＝セッションが無い。 */
    private Long queryOffset(String session, long total) throws GdriveException {
        HttpResponse<byte[]> r = execAbsolute(session, b -> b
                .header("Content-Range", "bytes */" + total).PUT(HttpRequest.BodyPublishers.noBody()));
        if (r.statusCode() == 308) {
            return nextOffset(r);
        }
        if (r.statusCode() == 200 || r.statusCode() == 201) {
            return -1L;
        }
        if (r.statusCode() == 404 || r.statusCode() == 410) {
            return null;
        }
        throw error(r);
    }

    private RemoteFile finishFromQuery(String session, long total) throws GdriveException {
        HttpResponse<byte[]> r = execAbsolute(session, b -> b
                .header("Content-Range", "bytes */" + total).PUT(HttpRequest.BodyPublishers.noBody()));
        return fileOf(parse(r));
    }

    private static long nextOffset(HttpResponse<byte[]> r) {
        String range = r.headers().firstValue("Range").orElse(null);
        if (range == null) {
            return 0;
        }
        return Long.parseLong(range.substring(range.indexOf('-') + 1).trim()) + 1;
    }

    private static RemoteFile fileOf(JsonNode n) {
        return new RemoteFile(n.path("id").asText(), n.path("name").asText(), n.path("md5Checksum").asText(null),
                n.path("size").asLong(0));
    }

    // ── 通信の共通部分 ────────────────────────────────────────────

    private String api(String path) {
        return apiBase + "/drive/v3" + path;
    }

    private String upload(String path) {
        return apiBase + "/upload/drive/v3" + path;
    }

    private HttpRequest.Builder request(String url, String token) {
        return HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + token);
    }

    /** 401 のときだけトークンを取り直して 1 回やり直す。接続できなければ OFFLINE。 */
    private HttpResponse<byte[]> exec(Function<String, HttpRequest> build) throws GdriveException {
        for (int attempt = 0; ; attempt++) {
            HttpResponse<byte[]> r = send(build.apply(tokens.accessToken()));
            if (r.statusCode() == 401 && attempt == 0) {
                tokens.invalidate();
                continue;
            }
            return r;
        }
    }

    /** セッション URI（絶対 URL）への PUT。{@code Authorization} は付ける。 */
    private HttpResponse<byte[]> execAbsolute(String url, Function<HttpRequest.Builder, HttpRequest.Builder> shape)
            throws GdriveException {
        return exec(t -> shape.apply(request(url, t)).build());
    }

    private HttpResponse<byte[]> send(HttpRequest req) throws GdriveException {
        try {
            return http.send(req, HttpResponse.BodyHandlers.ofByteArray());
        } catch (IOException e) {
            throw new GdriveException(Kind.OFFLINE, "network", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new GdriveException(Kind.OFFLINE, "interrupted", e);
        }
    }

    private static JsonNode parse(HttpResponse<byte[]> r) throws GdriveException {
        if (r.statusCode() / 100 != 2) {
            throw error(r);
        }
        try {
            return JSON.readTree(r.body());
        } catch (IOException e) {
            throw new GdriveException(Kind.RETRY, r.statusCode(), "response-invalid");
        }
    }

    static GdriveException error(HttpResponse<byte[]> r) {
        int s = r.statusCode();
        String reason = "";
        try {
            reason = JSON.readTree(r.body()).path("error").path("errors").path(0).path("reason").asText("");
        } catch (IOException | RuntimeException ignore) {
            // 本文が JSON でなければ status だけで判断
        }
        String msg = "http-" + s + (reason.isEmpty() ? "" : "-" + reason);
        if (s == 401) {
            return new GdriveException(Kind.RELOGIN, s, msg);
        }
        if (s == 403) {
            return switch (reason) {
                case "rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded" ->
                        new GdriveException(Kind.RETRY, s, msg);
                case "storageQuotaExceeded", "quotaExceeded", "dailyLimitExceeded", "teamDriveFileLimitExceeded",
                     "driveFileLimitExceeded" -> new GdriveException(Kind.QUOTA, s, msg);
                default -> new GdriveException(Kind.BLOCKED, s, msg);
            };
        }
        if (s == 404) {
            return new GdriveException(Kind.NOT_FOUND, s, msg);
        }
        if (s == 408 || s == 429 || s / 100 == 5) {
            return new GdriveException(Kind.RETRY, s, msg);
        }
        return new GdriveException(Kind.FATAL, s, msg);
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    /** Drive のクエリ文字列用（{@code \} と {@code '}）。 */
    static String esc(String s) {
        return s.replace("\\", "\\\\").replace("'", "\\'");
    }
}
