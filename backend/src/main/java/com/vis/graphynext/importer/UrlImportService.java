/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.store.StorageLayout;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * URL を指定して取り込む（fw/dicom-data-layer.md §4.4）。http/https から保管庫の作業フォルダ（{@code .import}）へ落とし、
 * DICOM ならそのまま {@link ImportService} に渡す。それ以外（NIfTI・画像・PDF・動画）は落としたパスを返し、
 * 画面が非 DICOM 取り込みのダイアログで続ける。ZIP は取り込み自体が未対応なので断る。
 *
 * <p>安全（OWASP A10 SSRF）: standalone だけ（サーバーから任意の URL を取りに行かせない）。スキームは http/https だけで、
 * リダイレクトは自前で辿って毎回スキームを確かめる。認証情報・Cookie は送らない。URL のクエリはログに出さない（秘密が混ざりうる）。
 */
@Service
@Profile("standalone")
public class UrlImportService {

    private static final Logger log = LoggerFactory.getLogger(UrlImportService.class);

    /** 終わったジョブ（と残った一時ファイル）を覚えておく時間。過ぎたら一時ファイルごと消す。 */
    private static final long FINISHED_TTL_MS = 60 * 60 * 1000L;
    /** リダイレクトを辿る上限（ループで止まらないため。ブラウザの既定 20 より小さくてよい）。 */
    private static final int MAX_REDIRECTS = 10;

    public enum State { QUEUED, DOWNLOADING, IMPORTING, DONE, FAILED, CANCELLED }

    /**
     * @param kind       "dicom"（取り込み済み）/ "file"（{@code path} を非 DICOM 取り込みで続ける）。終わるまで null
     * @param totalBytes Content-Length。分からなければ −1
     */
    public record Status(String jobId, State state, long receivedBytes, long totalBytes, String kind, String path,
                         String filename, ImportService.ImportResult importResult, String error) {
    }

    private static final class Job {
        final String id;
        volatile State state = State.QUEUED;
        volatile long received;
        volatile long total = -1;
        volatile String kind;
        volatile Path path;
        volatile String filename;
        volatile ImportService.ImportResult result;
        volatile String error;
        volatile long finishedAt;
        final AtomicBoolean cancelled = new AtomicBoolean();

        Job(String id) {
            this.id = id;
        }

        Status toStatus() {
            return new Status(id, state, received, total, kind, path == null ? null : path.toString(), filename, result, error);
        }
    }

    /** 利用者に見せてよい理由で止める。 */
    static final class Refused extends IOException {
        Refused(String message) {
            super(message);
        }
    }

    private final ImportService importer;
    private final Path workDir;
    private final HttpClient http;
    private final LongSupplier usableSpace;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService worker = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "url-import");
        t.setDaemon(true);
        return t;
    });

    @Autowired
    public UrlImportService(ImportService importer, StorageLayout layout) {
        this(importer, layout.root().resolve(".import"),
                // 接続 15 秒は Drive の取得（GdriveSyncService）とそろえる。リダイレクトは自前で辿る
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(15)).build(),
                () -> usable(layout.root()));
    }

    UrlImportService(ImportService importer, Path workDir, HttpClient http, LongSupplier usableSpace) {
        this.importer = importer;
        this.workDir = workDir;
        this.http = http;
        this.usableSpace = usableSpace;
    }

    private static long usable(Path root) {
        try {
            return Files.getFileStore(root).getUsableSpace();
        } catch (IOException e) {
            return Long.MAX_VALUE; // 測れないときは止めない（書き込みの失敗はそのまま失敗になる）
        }
    }

    public Status submit(String url) throws Refused {
        URI uri = checkUri(url);
        purgeOldJobs();
        Job job = new Job(UUID.randomUUID().toString());
        jobs.put(job.id, job);
        log.info("[url-import] job {} queued: {}", job.id, redact(uri));
        worker.submit(() -> run(job, uri));
        return job.toStatus();
    }

    public Status get(String jobId) {
        Job job = jobs.get(jobId);
        return job == null ? null : job.toStatus();
    }

    public Status cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) {
            return null;
        }
        job.cancelled.set(true);
        return job.toStatus();
    }

    /** 非 DICOM として返した一時ファイルを消す（画面が非 DICOM 取り込みを閉じたとき）。 */
    public boolean deleteFile(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null || job.path == null) {
            return false;
        }
        deleteQuietly(job.path);
        job.path = null;
        return true;
    }

    /** http/https だけ。ホストの無いもの・ユーザー情報付き（user:pass@）は断る。 */
    static URI checkUri(String url) throws Refused {
        URI uri;
        try {
            uri = URI.create(url == null ? "" : url.trim());
        } catch (IllegalArgumentException e) {
            throw new Refused("URL の形が正しくありません");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) {
            throw new Refused("http か https の URL だけを取り込めます");
        }
        if (uri.getHost() == null || uri.getHost().isBlank()) {
            throw new Refused("URL にホストがありません");
        }
        if (uri.getRawUserInfo() != null) {
            throw new Refused("認証情報を含む URL は扱いません");
        }
        return uri;
    }

    private void run(Job job, URI start) {
        try {
            if (job.cancelled.get()) {
                throw new CancelledException();
            }
            job.state = State.DOWNLOADING;
            Path file = download(job, start);
            job.path = file;
            byte[] head = readHead(file, 132);
            if (head.length >= 132 && head[128] == 'D' && head[129] == 'I' && head[130] == 'C' && head[131] == 'M') {
                job.state = State.IMPORTING;
                job.result = importer.importPaths(List.of(file.toString()));
                deleteQuietly(file);
                job.path = null;
                job.kind = "dicom";
            } else if (head.length >= 4 && head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4) {
                deleteQuietly(file);
                job.path = null;
                throw new Refused("ZIP は取り込めません（展開してから取り込んでください）");
            } else {
                job.kind = "file";
            }
            job.state = State.DONE;
            log.info("[url-import] job {} done: {} bytes, kind={}", job.id, job.received, job.kind);
        } catch (CancelledException e) {
            cleanup(job);
            job.state = State.CANCELLED;
            log.info("[url-import] job {} cancelled", job.id);
        } catch (Refused e) {
            cleanup(job);
            job.state = State.FAILED;
            job.error = e.getMessage();
            log.warn("[url-import] job {} refused: {}", job.id, e.getMessage());
        } catch (Exception e) {
            cleanup(job);
            job.state = State.FAILED;
            job.error = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            log.warn("[url-import] job {} failed", job.id, e);
        } finally {
            job.finishedAt = System.currentTimeMillis();
        }
    }

    private static final class CancelledException extends RuntimeException {
    }

    private Path download(Job job, URI start) throws IOException, InterruptedException {
        URI uri = start;
        for (int hop = 0; ; hop++) {
            // 応答の見出しまでの待ちは Drive の取得（DriveClient）と同じ 60 秒。本文の受信には上限を置かない（大きな検査がある）
            HttpRequest req = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(60)).GET().build();
            HttpResponse<InputStream> res = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
            int code = res.statusCode();
            if (code >= 300 && code < 400) {
                res.body().close();
                String loc = res.headers().firstValue("Location").orElse(null);
                if (loc == null) {
                    throw new Refused("リダイレクト先がありません（HTTP " + code + "）");
                }
                if (hop >= MAX_REDIRECTS) {
                    throw new Refused("リダイレクトが多すぎます");
                }
                uri = checkUri(uri.resolve(loc).toString());
                continue;
            }
            if (code != 200) {
                res.body().close();
                throw new Refused("取得できませんでした（HTTP " + code + "）");
            }
            long length = res.headers().firstValueAsLong("Content-Length").orElse(-1);
            job.total = length;
            long free = usableSpace.getAsLong();
            if (length > 0 && length > free) {
                res.body().close();
                throw new Refused("保管庫の空き容量が足りません（必要 " + length + " バイト・空き " + free + " バイト）");
            }
            String name = filename(res.headers().firstValue("Content-Disposition").orElse(null), uri,
                    res.headers().firstValue("Content-Type").orElse(null));
            job.filename = name;
            Files.createDirectories(workDir);
            Path file = workDir.resolve("url-" + job.id + "-" + name);
            job.path = file;
            try (InputStream in = res.body(); OutputStream out = Files.newOutputStream(file)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (job.cancelled.get()) {
                        throw new CancelledException();
                    }
                    out.write(buf, 0, n);
                    job.received += n;
                    if (job.received > free) {
                        // 長さが分からないまま、受け始めたときの空きを超えた
                        throw new Refused("保管庫の空き容量が足りません（受信 " + job.received + " バイト・空き " + free + " バイト）");
                    }
                }
            }
            if (length > 0 && job.received != length) {
                throw new Refused("途中で切れました（受信 " + job.received + " / " + length + " バイト）");
            }
            return file;
        }
    }

    private static final Pattern CD_FILENAME = Pattern.compile("filename\\*?=(?:UTF-8'')?\"?([^\";]+)\"?", Pattern.CASE_INSENSITIVE);

    /**
     * 保存名（作業フォルダの中だけで使う）。Content-Disposition → URL の末尾の順。拡張子が無ければ Content-Type から補う
     * （非 DICOM 取り込みは拡張子で種類を決めるため）。使える文字は英数字と {@code . _ -} だけにする。
     */
    static String filename(String contentDisposition, URI uri, String contentType) {
        String name = null;
        if (contentDisposition != null) {
            Matcher m = CD_FILENAME.matcher(contentDisposition);
            if (m.find()) {
                name = m.group(1);
            }
        }
        if (name == null || name.isBlank()) {
            String p = uri.getPath() == null ? "" : uri.getPath();
            name = p.substring(p.lastIndexOf('/') + 1);
        }
        name = java.net.URLDecoder.decode(name, java.nio.charset.StandardCharsets.UTF_8);
        name = name.substring(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
        name = name.replaceAll("[^A-Za-z0-9._-]", "_");
        while (name.startsWith(".")) {
            name = name.substring(1);
        }
        if (name.isBlank()) {
            name = "download";
        }
        if (!name.contains(".")) {
            name += extensionOf(contentType);
        }
        return name.length() > 120 ? name.substring(name.length() - 120) : name;
    }

    private static String extensionOf(String contentType) {
        String ct = contentType == null ? "" : contentType.split(";")[0].trim().toLowerCase(Locale.ROOT);
        return switch (ct) {
            case "application/dicom" -> ".dcm";
            case "application/pdf" -> ".pdf";
            case "image/png" -> ".png";
            case "image/jpeg" -> ".jpg";
            case "image/bmp" -> ".bmp";
            case "image/gif" -> ".gif";
            case "image/tiff" -> ".tif";
            case "video/mp4" -> ".mp4";
            case "video/quicktime" -> ".mov";
            case "video/x-msvideo" -> ".avi";
            default -> "";
        };
    }

    /** ログ用。クエリとフラグメントを落とす。 */
    static String redact(URI uri) {
        return uri.getScheme() + "://" + uri.getHost() + (uri.getPort() > 0 ? ":" + uri.getPort() : "")
                + (uri.getRawPath() == null ? "" : uri.getRawPath()) + (uri.getRawQuery() != null ? "?…" : "");
    }

    private static byte[] readHead(Path file, int n) throws IOException {
        try (InputStream in = Files.newInputStream(file)) {
            return in.readNBytes(n);
        }
    }

    private static void cleanup(Job job) {
        if (job.path != null) {
            deleteQuietly(job.path);
            job.path = null;
        }
    }

    private static void deleteQuietly(Path p) {
        try {
            Files.deleteIfExists(p);
        } catch (IOException e) {
            log.warn("[url-import] 一時ファイルを消せません: {}", p);
        }
    }

    private void purgeOldJobs() {
        long now = System.currentTimeMillis();
        for (Job j : jobs.values()) {
            if (j.finishedAt > 0 && now - j.finishedAt > FINISHED_TTL_MS) {
                cleanup(j);
                jobs.remove(j.id);
            }
        }
    }
}
