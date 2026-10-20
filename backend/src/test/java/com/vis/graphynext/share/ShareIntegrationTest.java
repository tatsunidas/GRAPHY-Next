/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 共有サービスを実際に起動して、発行 → 入口 → Cookie → 閲覧 → 取り消し の通しを確かめる。
 * 正例（許した経路が通る）と負例（範囲外・許可外・無認証・取り消し・当てずっぽう）を同じ流れで見る。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.datasource.url=jdbc:h2:mem:shareit;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false",
        "graphy.share.admin-key=" + ShareIntegrationTest.ADMIN,
        "graphy.share.session-secret=" + ShareIntegrationTest.SECRET,
        "graphy.share.public-base-url=https://share.example.test/",
        "graphy.share.failures-per-minute=6"
})
@ActiveProfiles("share")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ShareIntegrationTest {

    static final String ADMIN = "adminkey-adminkey-adminkey-adminkey-1234";
    static final String SECRET = "secret-secret-secret-secret-secret-1234";
    private static final String STUDY_A = "1.2.900.1";
    private static final String SERIES_A = "1.2.900.11";
    private static final String SOP_A = "1.2.900.111";
    private static final String STUDY_B = "1.2.900.2";
    private static final String SERIES_B = "1.2.900.21";
    private static final String SOP_B = "1.2.900.211";

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @LocalServerPort
    int port;
    @Autowired
    DicomStorageService storage;

    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
    private final ObjectMapper json = new ObjectMapper();
    private static boolean seeded;

    @BeforeAll
    static void resetSeed() {
        seeded = false;
    }

    private void seed() throws Exception {
        if (seeded) {
            return;
        }
        storage.ingest(phantom("PA", STUDY_A, SERIES_A, SOP_A));
        storage.ingest(phantom("PB", STUDY_B, SERIES_B, SOP_B));
        seeded = true;
    }

    private static Path phantom(String pid, String study, String series, String sop) throws Exception {
        Path f = Files.createTempFile("share", ".dcm");
        return DicomPhantomFactory.writeFile(f, DicomPhantomFactory.scImage(pid, study, series, sop),
                UID.ExplicitVRLittleEndian);
    }

    private HttpResponse<byte[]> send(String method, String path, String cookie, String bearer, String body)
            throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body));
        if (cookie != null) {
            b.header("Cookie", cookie);
        }
        if (bearer != null) {
            b.header("Authorization", "Bearer " + bearer);
        }
        if (body != null) {
            b.header("Content-Type", "application/json");
        }
        return http.send(b.build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private JsonNode issue(String... studies) throws Exception {
        String body = json.writeValueAsString(java.util.Map.of("studyUids", List.of(studies)));
        HttpResponse<byte[]> r = send("POST", "/api/share/grants", null, ADMIN, body);
        assertThat(r.statusCode()).isEqualTo(201);
        return json.readTree(r.body());
    }

    /** 入口を通して、閲覧セッションの Cookie（名前=値）を返す。 */
    private String enter(JsonNode issued) throws Exception {
        HttpResponse<byte[]> r = send("GET", issued.get("path").asText(), null, null, null);
        assertThat(r.statusCode()).isEqualTo(302);
        String setCookie = r.headers().firstValue("Set-Cookie").orElseThrow();
        assertThat(setCookie).contains("HttpOnly").contains("SameSite=Lax").contains("Path=/");
        assertThat(r.headers().firstValue("Location")).contains("/#share");
        assertThat(r.headers().firstValue("Cache-Control")).contains("no-store");
        assertThat(r.headers().firstValue("Referrer-Policy")).contains("no-referrer");
        return setCookie.substring(0, setCookie.indexOf(';'));
    }

    @Test
    @Order(1)
    void adminApiNeedsTheKey() throws Exception {
        String body = "{\"studyUids\":[\"" + STUDY_A + "\"]}";
        assertThat(send("POST", "/api/share/grants", null, null, body).statusCode()).isEqualTo(401);
        assertThat(send("POST", "/api/share/grants", null, "wrong", body).statusCode()).isEqualTo(401);
        assertThat(send("GET", "/api/share/grants", null, null, null).statusCode()).isEqualTo(401);
        assertThat(send("POST", "/api/share/grants", null, ADMIN, "{\"studyUids\":[]}").statusCode()).isEqualTo(400);
        JsonNode issued = issue(STUDY_A);
        assertThat(issued.get("url").asText()).startsWith("https://share.example.test/s/").doesNotContain("//s/");
        // 一覧にはトークンもハッシュも出ない
        String list = new String(send("GET", "/api/share/grants", null, ADMIN, null).body(), StandardCharsets.UTF_8);
        assertThat(list).contains(issued.get("id").asText()).contains("active");
        assertThat(list).doesNotContain(issued.get("path").asText().substring(3)).doesNotContain("tokenHash");
    }

    @Test
    @Order(2)
    void viewerSeesOnlyTheGrantedStudy() throws Exception {
        seed();
        JsonNode issued = issue(STUDY_A);
        String path = "/api/studies/" + STUDY_A + "/series/" + SERIES_A;

        // 入口の前は何も見えない（無認証は 404）
        assertThat(send("GET", "/api/studies/" + STUDY_A + "/series", null, null, null).statusCode()).isEqualTo(404);
        assertThat(send("GET", "/api/instances/" + SOP_A + "/file", null, null, null).statusCode()).isEqualTo(404);

        String cookie = enter(issued);

        // 共有の概要は許可した検査だけ
        String info = new String(send("GET", "/api/share/study", cookie, null, null).body(), StandardCharsets.UTF_8);
        assertThat(info).contains(STUDY_A).doesNotContain(STUDY_B);

        // 正例: 自分の検査のシリーズ・インスタンス・画像
        assertThat(send("GET", "/api/studies/" + STUDY_A + "/series", cookie, null, null).statusCode()).isEqualTo(200);
        assertThat(send("GET", path + "/instances", cookie, null, null).statusCode()).isEqualTo(200);
        for (String file : List.of(path + "/instances/" + SOP_A + "/file", "/api/instances/" + SOP_A + "/file")) {
            HttpResponse<byte[]> img = send("GET", file, cookie, null, null);
            assertThat(img.statusCode()).as(file).isEqualTo(200);
            assertThat(new String(img.body(), 128, 4, StandardCharsets.US_ASCII)).as("DICOM Part-10 の印").isEqualTo("DICM");
            assertThat(img.headers().firstValue("Cache-Control")).as("max-age を上書きして no-store").contains("no-store");
        }

        // 負例: 別の検査（パス指定・SOP 指定）、一覧・設定・書き込み、許可リストに無い経路
        assertThat(send("GET", "/api/studies/" + STUDY_B + "/series", cookie, null, null).statusCode()).isEqualTo(403);
        assertThat(send("GET", "/api/studies/" + STUDY_B + "/series/" + SERIES_B + "/instances/" + SOP_B + "/file",
                cookie, null, null).statusCode()).isEqualTo(403);
        assertThat(send("GET", "/api/instances/" + SOP_B + "/file", cookie, null, null).statusCode()).isEqualTo(403);
        assertThat(send("GET", "/api/instances/1.2.900.99999/file", cookie, null, null).statusCode())
                .as("存在しない SOP も 403（存在の有無を区別しない）").isEqualTo(403);
        assertThat(send("GET", "/api/studies", cookie, null, null).statusCode()).isEqualTo(404);
        assertThat(send("GET", "/api/settings", cookie, null, null).statusCode()).isEqualTo(404);
        assertThat(send("PUT", "/api/settings", cookie, null, "{\"x\":\"y\"}").statusCode()).isEqualTo(404);
        assertThat(send("POST", "/api/dicom/send", cookie, null, "{}").statusCode()).isEqualTo(404);
        assertThat(send("DELETE", "/api/studies/" + STUDY_A, cookie, null, null).statusCode()).isEqualTo(404);
        assertThat(send("GET", "/api/studies/" + STUDY_A + "/series/../../settings", cookie, null, null).statusCode())
                .isEqualTo(404);
        // 改ざんした Cookie は通らない
        assertThat(send("GET", "/api/share/study", cookie + "x", null, null).statusCode()).isEqualTo(404);
    }

    @Test
    @Order(3)
    void revocationTakesEffectImmediately() throws Exception {
        seed();
        JsonNode issued = issue(STUDY_A);
        String cookie = enter(issued);
        assertThat(send("GET", "/api/share/study", cookie, null, null).statusCode()).isEqualTo(200);

        assertThat(send("DELETE", "/api/share/grants/" + issued.get("id").asText(), null, ADMIN, null).statusCode())
                .isEqualTo(204);
        assertThat(send("GET", "/api/share/study", cookie, null, null).statusCode()).as("取り消し後の既存 Cookie").isEqualTo(404);
        assertThat(send("GET", issued.get("path").asText(), null, null, null).statusCode()).as("取り消し後の入口").isEqualTo(404);
        assertThat(send("DELETE", "/api/share/grants/no-such", null, ADMIN, null).statusCode()).isEqualTo(404);
    }

    @Test
    @Order(4)
    void invalidLinkInABrowserGetsAReadablePageButTheSameStatus() throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/s/" + "B".repeat(43)))
                .header("Accept", "text/html,application/xhtml+xml").GET().build();
        HttpResponse<String> r = http.send(req, HttpResponse.BodyHandlers.ofString());
        assertThat(r.statusCode()).isEqualTo(404);
        assertThat(r.headers().firstValue("Content-Type").orElse("")).startsWith("text/html");
        assertThat(r.body()).contains("無効か、期限が切れています").doesNotContain("B".repeat(43));
        // API 向け（Accept 指定なし）は従来どおり JSON
        HttpResponse<byte[]> api = send("GET", "/s/" + "B".repeat(43), null, null, null);
        assertThat(api.statusCode()).isEqualTo(404);
        assertThat(new String(api.body(), StandardCharsets.UTF_8)).contains("not found");
    }

    @Test
    @Order(5)
    void guessingTokensIsThrottled() throws Exception {
        seed();
        JsonNode issued = issue(STUDY_A);
        int notFound = 0;
        int status = 0;
        for (int i = 0; i < 12 && status != 429; i++) {
            status = send("GET", "/s/" + "A".repeat(43), null, null, null).statusCode();
            if (status == 404) {
                notFound++;
            }
        }
        assertThat(status).as("上限を超えたら 429").isEqualTo(429);
        assertThat(notFound).as("上限までは 404").isBetween(1, 6);
        // 上限を超えた IP は、正しいトークンでもしばらく入れない
        assertThat(send("GET", issued.get("path").asText(), null, null, null).statusCode()).isEqualTo(429);
    }
}
