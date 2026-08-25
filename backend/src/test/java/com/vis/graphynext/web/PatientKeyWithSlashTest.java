/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 🔴 <b>PatientID に {@code /} が入る患者で、保存系がまるごと壊れていた</b>ことの回帰テスト
 * （2026-08-26 に実データで発覚。Rubo の公開 XA サンプルの PatientID が {@code D97258/11053}）。
 *
 * <p>症状: ROI・プラグイン保存領域・位置合わせ記録が<b>その患者だけ保存されない</b>。
 * 画面にはエラーが出ず、描いた注釈が黙って消える。
 *
 * <p>原因: キーをパスに入れていたため。URL エンコードして {@code %2F} にしても
 * <b>Tomcat が経路の段で 400 を返す</b>（既定で符号化スラッシュを拒否する）。
 * Spring まで届かないので CORS ヘッダも付かず、ブラウザ側には
 * 「CORS エラー」としか見えない——原因に辿り着けない形で失敗していた。
 *
 * <h3>🚨 このテストは MockMvc では書けない</h3>
 * MockMvc は Tomcat の経路解析を通らないので、<b>壊れていた側（400）を再現できない</b>。
 * 実サーバ（{@code RANDOM_PORT}）で HTTP を実際に喋る必要がある。
 * 「単体テストは通るのに実機で落ちる」の典型なので、ここだけは重いテストを許容する。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:slashkey;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class PatientKeyWithSlashTest {

    /** 実データ（Rubo の公開 XA サンプル）と同じ形。 */
    private static final String KEY = "D97258/11053";

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @LocalServerPort
    int port;

    /**
     * 🚨 <b>RestTemplate は使えない</b>。URI をテンプレートとして扱い、{@code %2F} を
     * 再エンコード（{@code %252F}）してしまうため、<b>ブラウザが送るものと違う要求</b>になる
     * ——実際、最初 RestTemplate で書いたら「壊れていた側」が 200 で通ってしまった。
     * 生の {@code %2F} をそのまま送るために、素の {@link HttpClient} で喋る。
     */
    private final HttpClient http = HttpClient.newHttpClient();

    private URI url(String path) {
        return URI.create("http://localhost:" + port + path);
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private HttpResponse<String> get(String path) throws IOException, InterruptedException {
        return http.send(HttpRequest.newBuilder(url(path)).GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> put(String path, String json) throws IOException, InterruptedException {
        return http.send(
                HttpRequest.newBuilder(url(path))
                        .header("Content-Type", "application/json")
                        .PUT(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void roiDocumentRoundTripsWithSlashInPatientKey() throws Exception {
        // 保存 → 読み戻し。**キーが化けていないこと**まで見る（クエリの %2F が二重に
        // エンコードされると、別のキーの下に保存されて「保存できたのに次で消える」になる）。
        HttpResponse<String> saved = put(
                "/api/rois?patientKey=" + enc(KEY),
                "{\"json\":\"{\\\"rois\\\":[]}\",\"roiCount\":0,\"version\":null}");
        assertEquals(200, saved.statusCode(), saved.body());

        HttpResponse<String> read = get("/api/rois?patientKey=" + enc(KEY));
        assertEquals(200, read.statusCode(), read.body());
        assertTrue(read.body().contains("\"roiCount\":0"), "保存した内容が同じキーで読み戻せる: " + read.body());
        // 版が付いている＝**未保存の空の器ではない**（未保存なら version は null）。
        assertFalse(read.body().contains("\"version\":null"), "本当に保存された: " + read.body());
        assertTrue(read.body().contains(KEY), "キーがそのまま返る（化けていない）: " + read.body());
    }

    @Test
    void pluginStoreRoundTripsWithSlashInPatientKey() throws Exception {
        HttpResponse<String> res = get("/api/plugin-store/angio-quant?patientKey=" + enc(KEY));
        assertEquals(200, res.statusCode(), "プラグイン保存領域も同じ: " + res.body());
    }

    @Test
    void registrationDocumentRoundTripsWithSlashInPatientKey() throws Exception {
        HttpResponse<String> res = get("/api/registrations?patientKey=" + enc(KEY));
        assertEquals(200, res.statusCode(), "位置合わせ記録も同じ: " + res.body());
    }

    @Test
    void pathFormStillFailsForSlashKey_thatIsWhyTheQueryFormExists() throws Exception {
        // ★ 壊れていた側。**Tomcat が経路の段で 400 を返す**ので、パス版は / を含むキーに使えない
        //   （直すには Tomcat の経路解釈を緩めるしかなく、それは経路全体を弱める）。
        HttpResponse<String> res = get("/api/rois/" + enc(KEY));
        assertEquals(400, res.statusCode(), "符号化スラッシュを含むパスは Tomcat が弾く");
    }

    @Test
    void pathFormStillWorksForPlainKey() throws Exception {
        HttpResponse<String> res = get("/api/rois/PLAIN123");
        assertEquals(200, res.statusCode(), res.body());
    }
}
