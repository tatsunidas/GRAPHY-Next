/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.web.WebDicomDataService;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/** 偽の PACS（QIDO-RS / WADO-RS）。1 スタディ、{@code files[i]} が {@code sops[i]}（所属 {@code seriesOf[i]}）。 */
final class FakePacs implements AutoCloseable {

    final AtomicInteger wadoHits = new AtomicInteger();
    /** この SOP の取得は 500 を返す。 */
    volatile String failSop;
    /** 設定すると、WADO はこれが開くまで応答しない（実行中のジョブを作るため）。 */
    volatile CountDownLatch gate;
    /** STOW の受け取り。POST の回数・受け取ったパート数、{@code rejectPost}（0 始まり）番目の POST は先頭の1枚を拒否する。 */
    final AtomicInteger stowPosts = new AtomicInteger();
    final AtomicInteger stowParts = new AtomicInteger();
    volatile int rejectPost = -1;

    private final HttpServer server;
    final WebDicomDataService web;

    FakePacs(String study, String[] sops, String[] seriesOf, Path[] files) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/studies", ex -> handle(ex, study, sops, seriesOf, files));
        server.start();
        DicomProperties props = new DicomProperties();
        props.getDicomweb().setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort());
        web = new WebDicomDataService(props);
    }

    private void handle(HttpExchange ex, String study, String[] sops, String[] seriesOf, Path[] files)
            throws IOException {
        String path = ex.getRequestURI().getPath();
        if (path.equals("/studies") && "POST".equals(ex.getRequestMethod())) {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.ISO_8859_1);
            int n = body.split("Content-Type: application/dicom", -1).length - 1;
            stowParts.addAndGet(n);
            int post = stowPosts.getAndIncrement();
            json(ex, post == rejectPost
                    ? "{\"00081198\":{\"vr\":\"SQ\",\"Value\":[{\"00081155\":{\"vr\":\"UI\",\"Value\":[\"9.9.9\"]},\"00081197\":{\"vr\":\"US\",\"Value\":[272]}}]}}"
                    : "{\"00081199\":{\"vr\":\"SQ\",\"Value\":[{}]}}");
        } else if (path.equals("/studies")) {
            json(ex, "[{\"0020000D\":{\"vr\":\"UI\",\"Value\":[\"" + study + "\"]},"
                    + "\"00100020\":{\"vr\":\"LO\",\"Value\":[\"P1\"]}}]");
        } else if (path.equals("/studies/" + study + "/instances")) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < sops.length; i++) {
                sb.append(i == 0 ? "" : ",").append("{\"00080018\":{\"vr\":\"UI\",\"Value\":[\"").append(sops[i])
                        .append("\"]},\"0020000E\":{\"vr\":\"UI\",\"Value\":[\"").append(seriesOf[i]).append("\"]}}");
            }
            json(ex, sb.append("]").toString());
        } else if (path.contains("/instances/")) {
            wadoHits.incrementAndGet();
            CountDownLatch g = gate;
            if (g != null) {
                try {
                    g.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            String sop = path.substring(path.lastIndexOf('/') + 1);
            int idx = List.of(sops).indexOf(sop);
            if (idx < 0 || sop.equals(failSop)) {
                ex.sendResponseHeaders(500, -1);
                ex.close();
                return;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            bos.write("--b\r\nContent-Type: application/dicom\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            bos.write(Files.readAllBytes(files[idx]));
            bos.write("\r\n--b--\r\n".getBytes(StandardCharsets.US_ASCII));
            byte[] body = bos.toByteArray();
            ex.getResponseHeaders().add("Content-Type", "multipart/related; type=\"application/dicom\"; boundary=b");
            ex.sendResponseHeaders(200, body.length);
            try (var os = ex.getResponseBody()) {
                os.write(body);
            }
        } else {
            ex.sendResponseHeaders(404, -1);
            ex.close();
        }
    }

    private static void json(HttpExchange ex, String s) throws IOException {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/dicom+json");
        ex.sendResponseHeaders(200, b.length);
        try (var os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    @Override
    public void close() {
        CountDownLatch g = gate;
        if (g != null) {
            g.countDown();
        }
        server.stop(0);
    }
}
