/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.plugin.PluginProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.env.StandardEnvironment;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link PluginManagerService} の GitHub 取得オーケストレーション（fake client）と
 * モードゲートを検証する（ネットワーク非依存）。
 */
class PluginManagerServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static byte[] pluginZip() throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
            zos.putNextEntry(new ZipEntry("plugin.json"));
            zos.write(("{\"id\":\"acme\",\"name\":\"Acme\",\"version\":\"1.0.0\","
                    + "\"contributes\":[\"viewer2d.menu\"],\"ui\":\"ui.js\","
                    + "\"engines\":{\"graphy\":\">=0.2.0 <0.3.0\"}}").getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
            zos.putNextEntry(new ZipEntry("ui.js"));
            zos.write("export function activate(h){}".getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
        }
        return baos.toByteArray();
    }

    /** zip 資産＋sha256 資産を1リリースだけ返す fake。 */
    private static GitHubReleaseClient fakeClient(byte[] zip) {
        String sha = PluginPackage.sha256(zip);
        return new GitHubReleaseClient() {
            @Override
            public List<Release> listReleases(String repo, String token) {
                Asset zipAsset = new Asset("acme.zip", "api-zip", "zip-url", zip.length);
                Asset shaAsset = new Asset("acme.zip.sha256", "api-sha", "sha-url", 64);
                return List.of(new Release("v1.0.0", "1.0.0", "notes", "2026-01-01", false,
                        List.of(zipAsset, shaAsset)));
            }

            @Override
            public byte[] download(String url, String token) {
                return switch (url) {
                    case "zip-url" -> zip;
                    case "sha-url" -> (sha + "  acme.zip").getBytes(StandardCharsets.UTF_8);
                    default -> throw new PluginInstallException("unexpected url " + url);
                };
            }
        };
    }

    private PluginManagerService service(Path dir, GitHubReleaseClient client, boolean managerEnabled, String profile) {
        PluginProperties props = new PluginProperties();
        props.setDir(dir.toString());
        props.setManagerEnabled(managerEnabled);
        StandardEnvironment env = new StandardEnvironment();
        env.setActiveProfiles(profile);
        return new PluginManagerService(props, MAPPER, client, env, "0.2.5");
    }

    @Test
    void installsFromGitHubWithSha256Verification(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip();
        PluginManagerService svc = service(dir, fakeClient(zip), true, "standalone");

        InstalledPlugin rec = svc.installFromGitHub("owner/acme", null);

        assertEquals("acme", rec.id());
        assertEquals("github", rec.source().type());
        assertEquals("owner/acme", rec.source().ref());
        assertEquals(PluginPackage.sha256(zip), rec.sha256());
        assertTrue(Files.isRegularFile(dir.resolve("acme/plugin.json")));
        assertEquals(1, svc.installed().size());
    }

    @Test
    void versionsListsReleases(@TempDir Path dir) throws Exception {
        PluginManagerService svc = service(dir, fakeClient(pluginZip()), true, "standalone");
        List<PluginManagerService.AvailableVersion> versions = svc.versions("owner/acme");
        assertEquals(1, versions.size());
        assertEquals("v1.0.0", versions.get(0).tag());
        assertEquals("acme.zip", versions.get(0).zipAsset());
    }

    @Test
    void webModeForbidsInstall(@TempDir Path dir) throws Exception {
        PluginManagerService svc = service(dir, fakeClient(pluginZip()), true, "web");
        assertThrows(PluginManagerForbiddenException.class, () -> svc.installFromGitHub("owner/acme", null));
        // 一覧の読み取りは web でも可能。
        assertTrue(svc.installed().isEmpty());
    }

    @Test
    void managerDisabledForbidsInstall(@TempDir Path dir) throws Exception {
        PluginManagerService svc = service(dir, fakeClient(pluginZip()), false, "standalone");
        assertThrows(PluginManagerForbiddenException.class, () -> svc.installFromGitHub("owner/acme", null));
    }

    @Test
    void statusReflectsMode(@TempDir Path dir) throws Exception {
        assertTrue(service(dir, fakeClient(pluginZip()), true, "standalone").managerStatus().canManage());
        assertTrue(!service(dir, fakeClient(pluginZip()), true, "web").managerStatus().canManage());
        assertTrue(!service(dir, fakeClient(pluginZip()), false, "standalone").managerStatus().canManage());
    }
}
