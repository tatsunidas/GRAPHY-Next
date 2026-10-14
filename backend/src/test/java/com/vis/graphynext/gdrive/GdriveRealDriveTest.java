/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 実際の Drive を相手にした検証。<b>通常のビルドでは動かない</b>（環境変数が要る）。
 *
 * <pre>
 * GDRIVE_REAL_PARENT=&lt;Picker で選んだフォルダの id&gt;
 * GDRIVE_REAL_CLIENT=&lt;desktop/gdrive-oauth-client.json&gt;   GDRIVE_REAL_TOKEN=&lt;{"refresh_token":…} のファイル&gt;
 * mvn -o test -Dtest=GdriveRealDriveTest
 * </pre>
 * 親の直下に {@code GRAPHY-DB-real-test-…} を作り、終わりにそのフォルダだけゴミ箱へ移す。
 */
@DataJpaTest(properties = {"spring.jpa.hibernate.ddl-auto=create-drop"})
@EnabledIfEnvironmentVariable(named = "GDRIVE_REAL_PARENT", matches = ".+")
class GdriveRealDriveTest {

    @Autowired
    GdriveSyncRepository repo;

    @TempDir
    Path root;

    private static byte[] rnd(int n, long seed) {
        byte[] b = new byte[n];
        new Random(seed).nextBytes(b);
        return b;
    }

    @Test
    void 実_Drive_で増分反映_更新_削除_台帳喪失からの復旧() throws Exception {
        ObjectMapper om = new ObjectMapper();
        JsonNode client = om.readTree(Files.readString(Path.of(System.getenv("GDRIVE_REAL_CLIENT")))).path("installed");
        String refresh = om.readTree(Files.readString(Path.of(System.getenv("GDRIVE_REAL_TOKEN")))).path("refresh_token").asText();
        String parent = System.getenv("GDRIVE_REAL_PARENT");

        GdriveConfig boot = new GdriveConfig(client.path("client_id").asText(), client.path("client_secret").asText(),
                refresh, parent, null, "real");
        java.net.http.HttpClient http = java.net.http.HttpClient.newBuilder()
                .followRedirects(java.net.http.HttpClient.Redirect.NEVER).build();
        DriveClient admin = new DriveClient(http, "https://www.googleapis.com",
                new GdriveTokenSource(http, "https://oauth2.googleapis.com/token", () -> boot, Clock.systemUTC()));
        String dbFolder = admin.ensureFolder(parent, "GRAPHY-DB-real-test-" + System.currentTimeMillis());
        GdriveConfig cfg = new GdriveConfig(boot.clientId(), boot.clientSecret(), refresh, dbFolder, null, "real");
        try {
            GdriveSyncService svc = new GdriveSyncService(repo, root, "https://www.googleapis.com",
                    "https://oauth2.googleapis.com/token", Clock.systemUTC(), Math::random, 30_000, 600_000, false);
            svc.configure(cfg);

            byte[] small = rnd(200_000, 1);
            byte[] big = rnd(DriveClient.CHUNK + 1_500_000, 2); // 2 チャンクにまたがる
            Path p1 = put("1.1/2.1/3.1.dcm", small);
            put("1.1/2.1/3.2.dcm", big);
            svc.cycle();
            assertEquals(GdriveSyncService.State.CONNECTED, svc.status().state(), String.valueOf(svc.status()));

            String dicom = admin.ensureFolder(dbFolder, "dicom");
            List<DriveClient.RemoteFile> remote = admin.listFiles(dicom);
            assertEquals(2, remote.size());
            assertEquals(GdriveSyncService.md5(root.resolve("1.1/2.1/3.2.dcm")),
                    remote.stream().filter(f -> f.name().equals("1.1~2.1~3.2.dcm")).findFirst().orElseThrow().md5());

            // 更新: 同じ Drive ファイルが新しい内容になる
            byte[] v2 = rnd(250_000, 3);
            Files.write(p1, v2);
            Files.setLastModifiedTime(p1, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 5000));
            svc.syncNow();
            svc.cycle();
            remote = admin.listFiles(dicom);
            assertEquals(2, remote.size());
            assertEquals(GdriveSyncService.md5(p1),
                    remote.stream().filter(f -> f.name().equals("1.1~2.1~3.1.dcm")).findFirst().orElseThrow().md5());

            // 台帳を失っても二重にならない
            repo.deleteAll();
            repo.flush();
            svc.configure(cfg);
            svc.cycle();
            assertEquals(2, admin.listFiles(dicom).size(), "台帳喪失後も重複しない");

            // 削除はゴミ箱へ（listFiles は trashed=false だけ見る）
            Files.delete(root.resolve("1.1/2.1/3.2.dcm"));
            svc.syncNow();
            svc.cycle();
            remote = admin.listFiles(dicom);
            assertEquals(1, remote.size());
            assertTrue(remote.get(0).name().endsWith("3.1.dcm"));
            assertEquals(0, svc.status().pending());
        } finally {
            admin.trash(dbFolder);
        }
    }

    private Path put(String rel, byte[] data) throws java.io.IOException {
        Path p = root.resolve(rel);
        Files.createDirectories(p.getParent());
        Files.write(p, data);
        return p;
    }
}
