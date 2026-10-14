/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 偽の Drive（テスト用）。必要な API だけを、実機で確かめた挙動（P0）に合わせて真似る。 */
class FakeDrive implements AutoCloseable {

    static final class File {
        String id;
        String name;
        String parent;
        boolean folder;
        boolean trashed;
        byte[] bytes = new byte[0];
    }

    /** 次の要求への応答を差し替える。null を返せば通常処理。 */
    interface Fault {
        /** @return 応答 status。-1 なら接続を切る。null なら通常。 */
        Integer on(String method, String path, HttpExchange ex);
    }

    final Map<String, File> files = new LinkedHashMap<>();
    final List<String> log = new java.util.concurrent.CopyOnWriteArrayList<>();
    final ConcurrentLinkedQueue<Fault> faults = new ConcurrentLinkedQueue<>();
    final AtomicInteger tokenCalls = new AtomicInteger();
    volatile String reason403 = "forbidden";
    volatile String tokenError;          // invalid_grant など
    volatile String wrongMd5;            // 完了時に返す md5 を偽る
    volatile long wasted;                // 受け取り済みの位置から外れて送られた（無駄になった）バイト数
    volatile long bytesReceived;         // PUT で受け取ったバイト総量
    private final Map<String, Session> sessions = new java.util.HashMap<>();
    private int seq;
    private final HttpServer server;

    private static final class Session {
        String fileId;
        String name;
        String parent;
        long total;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
    }

    FakeDrive() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.start();
    }

    String base() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    String tokenUrl() {
        return base() + "/token";
    }

    @Override
    public void close() {
        server.stop(0);
    }

    synchronized List<File> live(String name) {
        List<File> out = new ArrayList<>();
        for (File f : files.values()) {
            if (!f.folder && !f.trashed && f.name.equals(name)) {
                out.add(f);
            }
        }
        return out;
    }

    synchronized int liveCount() {
        return (int) files.values().stream().filter(f -> !f.folder && !f.trashed).count();
    }

    static String md5(byte[] b) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(b));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private synchronized void handle(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getPath();
        String query = ex.getRequestURI().getRawQuery() == null ? "" : ex.getRequestURI().getRawQuery();
        log.add(method + " " + path);
        byte[] body = ex.getRequestBody().readAllBytes();
        if (path.equals("/token")) {
            tokenCalls.incrementAndGet();
            if (tokenError != null) {
                reply(ex, 400, "{\"error\":\"" + tokenError + "\"}");
            } else {
                reply(ex, 200, "{\"access_token\":\"tok-" + tokenCalls.get() + "\",\"expires_in\":3600}");
            }
            return;
        }
        Fault f = faults.peek();
        if (f != null) {
            Integer r = f.on(method, path, ex);
            if (r != null) {
                faults.poll();
                if (r == -1) {
                    ex.close(); // 応答せずに切る
                } else if (r == 403) {
                    reply(ex, 403, "{\"error\":{\"errors\":[{\"reason\":\"" + reason403 + "\"}]}}");
                } else {
                    reply(ex, r, "{\"error\":{\"errors\":[{\"reason\":\"x\"}]}}");
                }
                return;
            }
        }
        if (path.startsWith("/upload/drive/v3/files")) {
            startSession(ex, method, path, query, body);
        } else if (path.startsWith("/session/")) {
            putSession(ex, path, body);
        } else if (path.equals("/drive/v3/files") && method.equals("GET")) {
            list(ex, query);
        } else if (path.equals("/drive/v3/files") && method.equals("POST")) {
            createFolder(ex, body);
        } else if (path.startsWith("/drive/v3/files/") && method.equals("PATCH")) {
            File t = files.get(path.substring("/drive/v3/files/".length()));
            if (t == null) {
                reply(ex, 404, "{\"error\":{\"errors\":[{\"reason\":\"notFound\"}]}}");
                return;
            }
            t.trashed = new String(body, StandardCharsets.UTF_8).contains("\"trashed\":true");
            reply(ex, 200, "{\"id\":\"" + t.id + "\"}");
        } else {
            reply(ex, 404, "{}");
        }
    }

    private static String param(String q, String key) {
        for (String kv : q.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0 && kv.substring(0, i).equals(key)) {
                return URLDecoder.decode(kv.substring(i + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private void list(HttpExchange ex, String query) throws IOException {
        String q = param(query, "q");
        Matcher n = Pattern.compile("name='((?:[^'\\\\]|\\\\.)*)'").matcher(q);
        String name = n.find() ? n.group(1).replace("\\'", "'").replace("\\\\", "\\") : null;
        Matcher p = Pattern.compile("'([^']+)' in parents").matcher(q);
        String parent = p.find() ? p.group(1) : null;
        boolean wantFolder = q.contains("mimeType='application/vnd.google-apps.folder'");
        StringBuilder sb = new StringBuilder("{\"files\":[");
        boolean first = true;
        for (File f : files.values()) {
            if (f.trashed || (name != null && !f.name.equals(name)) || (parent != null && !parent.equals(f.parent))
                    || f.folder != wantFolder) {
                continue;
            }
            sb.append(first ? "" : ",").append("{\"id\":\"").append(f.id).append("\",\"name\":\"").append(f.name).append("\"");
            if (!f.folder) {
                sb.append(",\"md5Checksum\":\"").append(md5(f.bytes)).append("\",\"size\":\"").append(f.bytes.length).append("\"");
            }
            sb.append("}");
            first = false;
        }
        reply(ex, 200, sb.append("]}").toString());
    }

    private void createFolder(HttpExchange ex, byte[] body) throws IOException {
        String s = new String(body, StandardCharsets.UTF_8);
        File f = new File();
        f.id = "fld" + (++seq) + "xxxxxxxxxx";
        f.name = field(s, "name");
        f.parent = s.replaceAll("(?s).*\"parents\":\\[\"([^\"]+)\"].*", "$1");
        f.folder = true;
        files.put(f.id, f);
        reply(ex, 200, "{\"id\":\"" + f.id + "\"}");
    }

    private static String field(String json, String key) {
        Matcher m = Pattern.compile("\"" + key + "\":\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : null;
    }

    private void startSession(HttpExchange ex, String method, String path, String query, byte[] body) throws IOException {
        String s = new String(body, StandardCharsets.UTF_8);
        Session se = new Session();
        String idPart = path.substring("/upload/drive/v3/files".length());
        se.fileId = idPart.startsWith("/") ? idPart.substring(1) : null;
        se.name = field(s, "name");
        se.parent = s.contains("parents") ? s.replaceAll("(?s).*\"parents\":\\[\"([^\"]+)\"].*", "$1") : null;
        se.total = Long.parseLong(ex.getRequestHeaders().getFirst("X-Upload-Content-Length"));
        if (se.fileId != null && !files.containsKey(se.fileId)) {
            reply(ex, 404, "{\"error\":{\"errors\":[{\"reason\":\"notFound\"}]}}");
            return;
        }
        String sid = "s" + (++seq);
        sessions.put(sid, se);
        ex.getResponseHeaders().add("Location", base() + "/session/" + sid);
        reply(ex, 200, "{}");
    }

    private void putSession(HttpExchange ex, String path, byte[] body) throws IOException {
        Session se = sessions.get(path.substring("/session/".length()));
        if (se == null) {
            reply(ex, 404, "{}");
            return;
        }
        String cr = ex.getRequestHeaders().getFirst("Content-Range");
        bytesReceived += body.length;
        if (cr != null && cr.startsWith("bytes */") && body.length == 0) {
            // 状態問い合わせ
        } else if (cr != null && !cr.startsWith("bytes */")) {
            long from = Long.parseLong(cr.substring(6, cr.indexOf('-')));
            if (from != se.buf.size()) {
                // Drive は受け取り済みの位置から外れた送信を 308 で正す
                bytesReceived -= body.length;
                wasted += body.length;
            } else {
                se.buf.write(body);
            }
        } else if (cr == null) {
            se.buf.write(body);
        }
        if (se.buf.size() >= se.total) {
            File f = se.fileId != null ? files.get(se.fileId) : new File();
            if (f.id == null) {
                f.id = "file" + (++seq) + "xxxxxxxx";
                f.name = se.name;
                f.parent = se.parent;
                files.put(f.id, f);
            }
            f.bytes = se.buf.toByteArray();
            f.trashed = false;
            String m = wrongMd5 != null ? wrongMd5 : md5(f.bytes);
            reply(ex, 200, "{\"id\":\"" + f.id + "\",\"name\":\"" + f.name + "\",\"md5Checksum\":\"" + m + "\",\"size\":\"" + f.bytes.length + "\"}");
            return;
        }
        if (se.buf.size() > 0) {
            ex.getResponseHeaders().add("Range", "bytes=0-" + (se.buf.size() - 1));
        }
        reply(ex, 308, "");
    }

    private static void reply(HttpExchange ex, int status, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, b.length == 0 ? -1 : b.length);
        if (b.length > 0) {
            ex.getResponseBody().write(b);
        }
        ex.close();
    }
}
