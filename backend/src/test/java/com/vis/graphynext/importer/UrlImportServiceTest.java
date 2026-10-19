/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import com.vis.graphynext.dicom.store.StorageLayout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** URL 取り込み: ローカルの HTTP サーバーから落として振り分ける・断る・中止する。 */
class UrlImportServiceTest {

    @TempDir
    Path tmp;
    private HttpServer server;
    private String base;
    private final List<List<String>> imported = new ArrayList<>();
    /** 取り込みのときに、渡されたファイルが実在したか。 */
    private final List<Boolean> existedOnImport = new ArrayList<>();

    private static byte[] dicomBytes() {
        byte[] b = new byte[300];
        b[128] = 'D';
        b[129] = 'I';
        b[130] = 'C';
        b[131] = 'M';
        return b;
    }

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/scan.dcm", ex -> send(ex, 200, dicomBytes(), null));
        server.createContext("/brain.nii.gz", ex -> send(ex, 200, new byte[] { 0x1f, (byte) 0x8b, 8, 0, 1, 2, 3 }, null));
        server.createContext("/archive.zip", ex -> send(ex, 200, new byte[] { 'P', 'K', 3, 4, 0, 0 }, null));
        server.createContext("/download", ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/pdf");
            send(ex, 200, "%PDF-1.4".getBytes(), null);
        });
        server.createContext("/evil", ex -> {
            ex.getResponseHeaders().add("Content-Disposition", "attachment; filename=\"../../etc/pass wd.png\"");
            send(ex, 200, new byte[] { 1, 2, 3 }, null);
        });
        server.createContext("/to-file", ex -> send(ex, 302, new byte[0], "file:///etc/passwd"));
        server.createContext("/to-dicom", ex -> send(ex, 302, new byte[0], "/scan.dcm"));
        server.createContext("/missing", ex -> send(ex, 404, new byte[0], null));
        server.createContext("/big", ex -> send(ex, 200, new byte[1000], null));
        server.createContext("/slow", ex -> {
            ex.sendResponseHeaders(200, 0); // 長さ不明（chunked）で少しずつ送る
            try (OutputStream out = ex.getResponseBody()) {
                for (int i = 0; i < 200; i++) {
                    out.write(new byte[1024]);
                    out.flush();
                    Thread.sleep(20);
                }
            } catch (InterruptedException | IOException ignore) {
                // 中止で切られる
            }
        });
        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private static void send(com.sun.net.httpserver.HttpExchange ex, int code, byte[] body, String location) throws IOException {
        if (location != null) {
            ex.getResponseHeaders().add("Location", location);
        }
        ex.sendResponseHeaders(code, body.length == 0 ? -1 : body.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(body);
        }
    }

    private UrlImportService service(long freeBytes) {
        ImportService fake = new ImportService(null, new StorageLayout(tmp.resolve("store"))) {
            @Override
            public ImportResult importPaths(List<String> paths) {
                imported.add(paths);
                existedOnImport.add(Files.exists(Path.of(paths.get(0))));
                return new ImportResult(1, 0, 0, 0, List.of(), List.of("1.2.3"));
            }
        };
        return new UrlImportService(fake, tmp.resolve("work"),
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build(), () -> freeBytes);
    }

    private static UrlImportService.Status await(UrlImportService s, String id) throws InterruptedException {
        for (int i = 0; i < 500; i++) {
            UrlImportService.Status st = s.get(id);
            if (st.state() == UrlImportService.State.DONE || st.state() == UrlImportService.State.FAILED
                    || st.state() == UrlImportService.State.CANCELLED) {
                return st;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("終わらない: " + s.get(id));
    }

    private long workFiles() throws IOException {
        Path w = tmp.resolve("work");
        if (!Files.exists(w)) {
            return 0;
        }
        try (Stream<Path> s = Files.list(w)) {
            return s.count();
        }
    }

    @Test
    void DICOM_はそのまま取り込み_一時ファイルは残らない() throws Exception {
        UrlImportService s = service(Long.MAX_VALUE);
        UrlImportService.Status st = await(s, s.submit(base + "/scan.dcm?token=secret").jobId());
        assertThat(st.state()).isEqualTo(UrlImportService.State.DONE);
        assertThat(st.kind()).isEqualTo("dicom");
        assertThat(st.importResult().imported()).isEqualTo(1);
        assertThat(imported).hasSize(1);
        assertThat(existedOnImport).containsExactly(true);
        assertThat(workFiles()).isZero();
    }

    @Test
    void DICOM_でないものはパスを返し_消す口で消える() throws Exception {
        UrlImportService s = service(Long.MAX_VALUE);
        UrlImportService.Status st = await(s, s.submit(base + "/brain.nii.gz").jobId());
        assertThat(st.state()).isEqualTo(UrlImportService.State.DONE);
        assertThat(st.kind()).isEqualTo("file");
        assertThat(st.filename()).isEqualTo("brain.nii.gz");
        assertThat(Path.of(st.path())).exists().hasFileName("url-" + st.jobId() + "-brain.nii.gz");
        assertThat(imported).isEmpty();
        assertThat(s.deleteFile(st.jobId())).isTrue();
        assertThat(Path.of(st.path())).doesNotExist();
    }

    @Test
    void ZIP_は断り_何も残らない() throws Exception {
        UrlImportService s = service(Long.MAX_VALUE);
        UrlImportService.Status st = await(s, s.submit(base + "/archive.zip").jobId());
        assertThat(st.state()).isEqualTo(UrlImportService.State.FAILED);
        assertThat(st.error()).contains("ZIP");
        assertThat(workFiles()).isZero();
    }

    @Test
    void http_https_以外と認証情報付きは投入の時点で断る() {
        UrlImportService s = service(Long.MAX_VALUE);
        assertThatThrownBy(() -> s.submit("file:///etc/passwd")).isInstanceOf(UrlImportService.Refused.class);
        assertThatThrownBy(() -> s.submit("ftp://example.com/a.dcm")).isInstanceOf(UrlImportService.Refused.class);
        assertThatThrownBy(() -> s.submit("http://user:pw@example.com/a.dcm")).isInstanceOf(UrlImportService.Refused.class);
        assertThatThrownBy(() -> s.submit("not a url")).isInstanceOf(UrlImportService.Refused.class);
    }

    @Test
    void file_へのリダイレクトは断り_http_へのリダイレクトは辿る() throws Exception {
        UrlImportService s = service(Long.MAX_VALUE);
        UrlImportService.Status bad = await(s, s.submit(base + "/to-file").jobId());
        assertThat(bad.state()).isEqualTo(UrlImportService.State.FAILED);
        assertThat(bad.error()).contains("http か https");
        UrlImportService.Status ok = await(s, s.submit(base + "/to-dicom").jobId());
        assertThat(ok.state()).isEqualTo(UrlImportService.State.DONE);
        assertThat(ok.kind()).isEqualTo("dicom");
    }

    @Test
    void HTTP_のエラーは理由つきで失敗() throws Exception {
        UrlImportService s = service(Long.MAX_VALUE);
        UrlImportService.Status st = await(s, s.submit(base + "/missing").jobId());
        assertThat(st.state()).isEqualTo(UrlImportService.State.FAILED);
        assertThat(st.error()).contains("404");
    }

    @Test
    void 空き容量が足りなければ受け取る前に止める() throws Exception {
        UrlImportService s = service(999);
        UrlImportService.Status st = await(s, s.submit(base + "/big").jobId());
        assertThat(st.state()).isEqualTo(UrlImportService.State.FAILED);
        assertThat(st.error()).contains("空き容量");
        assertThat(workFiles()).isZero();
        // 負例の確認: 空きがちょうどあれば通る
        UrlImportService ok = service(1000);
        assertThat(await(ok, ok.submit(base + "/big").jobId()).state()).isEqualTo(UrlImportService.State.DONE);
    }

    @Test
    void 長さ不明でも受信中に空きを超えたら止める() throws Exception {
        UrlImportService s = service(10 * 1024);
        UrlImportService.Status st = await(s, s.submit(base + "/slow").jobId());
        assertThat(st.state()).isEqualTo(UrlImportService.State.FAILED);
        assertThat(st.error()).contains("空き容量");
        assertThat(workFiles()).isZero();
    }

    @Test
    void 中止すると一時ファイルが残らない() throws Exception {
        UrlImportService s = service(Long.MAX_VALUE);
        String id = s.submit(base + "/slow").jobId();
        for (int i = 0; i < 200 && s.get(id).receivedBytes() == 0; i++) {
            Thread.sleep(10);
        }
        assertThat(s.get(id).receivedBytes()).isPositive(); // 受信が始まってから中止する
        s.cancel(id);
        UrlImportService.Status st = await(s, id);
        assertThat(st.state()).isEqualTo(UrlImportService.State.CANCELLED);
        assertThat(workFiles()).isZero();
    }

    @Test
    void 保存名は拡張子を補い_危ない文字とパスを落とす() throws Exception {
        UrlImportService s = service(Long.MAX_VALUE);
        assertThat(await(s, s.submit(base + "/download").jobId()).filename()).isEqualTo("download.pdf");
        UrlImportService.Status evil = await(s, s.submit(base + "/evil").jobId());
        assertThat(evil.filename()).isEqualTo("pass_wd.png");
        assertThat(Path.of(evil.path()).getParent()).isEqualTo(tmp.resolve("work"));
    }

    @Test
    void ログに出す_URL_はクエリを落とす() {
        assertThat(UrlImportService.redact(java.net.URI.create("https://h.example:8443/a/b.dcm?token=secret#x")))
                .isEqualTo("https://h.example:8443/a/b.dcm?…").doesNotContain("secret");
    }
}
