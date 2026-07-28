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
        return pluginZip(null, false);
    }

    /**
     * @param osJson {@code engines.os} に入れる JSON 配列（null なら OS 非依存）
     * @param withJar 同梱 JAR を入れるか（同意画面の「アプリと同じ権限で動く」表示の検証用）
     */
    private static byte[] pluginZip(String osJson, boolean withJar) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
            zos.putNextEntry(new ZipEntry("plugin.json"));
            zos.write(("{\"id\":\"acme\",\"name\":\"Acme\",\"version\":\"1.0.0\","
                    + "\"contributes\":[\"viewer2d.menu\"],\"ui\":\"ui.js\","
                    + "\"permissions\":[\"read-pixels\"],"
                    + "\"engines\":{\"graphy\":\">=0.2.0 <0.3.0\""
                    + (osJson == null ? "" : ",\"os\":" + osJson) + "}}").getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
            zos.putNextEntry(new ZipEntry("ui.js"));
            zos.write("export function activate(h){}".getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
            if (withJar) {
                zos.putNextEntry(new ZipEntry("backend.jar"));
                zos.write("not really a jar".getBytes(StandardCharsets.UTF_8));
                zos.closeEntry();
            }
        }
        return baos.toByteArray();
    }

    /** sha256 資産を持たないリリースを返す fake（完全性を検証できないケース）。 */
    private static GitHubReleaseClient clientWithoutSha(byte[] zip) {
        return new GitHubReleaseClient() {
            @Override
            public List<Release> listReleases(String repo, String token) {
                return List.of(new Release("v1.0.0", "1.0.0", "notes", "2026-01-01", false,
                        List.of(new Asset("acme.zip", "api-zip", "zip-url", zip.length))));
            }

            @Override
            public byte[] download(String url, String token) {
                if ("zip-url".equals(url)) return zip;
                throw new PluginInstallException("unexpected url " + url);
            }
        };
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

    /** ユーザーがオプトイン済み（トグル ON）の前提で組み立てる。 */
    private PluginManagerService service(Path dir, GitHubReleaseClient client, boolean managerEnabled, String profile) {
        return service(dir, client, managerEnabled, profile, true);
    }

    private PluginManagerService service(Path dir, GitHubReleaseClient client, boolean managerEnabled,
                                         String profile, boolean optedIn) {
        return service(dir, client, managerEnabled, profile, optedIn, List.of());
    }

    private PluginManagerService service(Path dir, GitHubReleaseClient client, boolean managerEnabled,
                                         String profile, boolean optedIn, List<String> trustedKeys) {
        PluginProperties props = new PluginProperties();
        props.setDir(dir.toString());
        props.setManagerEnabled(managerEnabled);
        props.setTrustedKeys(trustedKeys);
        StandardEnvironment env = new StandardEnvironment();
        env.setActiveProfiles(profile);
        return new PluginManagerService(props, MAPPER, client, env, () -> optedIn, "0.2.5");
    }

    /** zip・.minisig・minisign.pub を持つリリースを返す fake（署名経路の検証用）。 */
    private static GitHubReleaseClient signedClient(byte[] zip, String minisig, String pub) {
        return new GitHubReleaseClient() {
            @Override
            public List<Release> listReleases(String repo, String token) {
                return List.of(new Release("v1.0.0", "1.0.0", "notes", "2026-01-01", false,
                        List.of(new Asset("acme.zip", "api-zip", "zip-url", zip.length),
                                new Asset("acme.zip.minisig", "api-sig", "sig-url", 200),
                                new Asset("minisign.pub", "api-pub", "pub-url", 60))));
            }

            @Override
            public byte[] download(String url, String token) {
                return switch (url) {
                    case "zip-url" -> zip;
                    case "sig-url" -> minisig.getBytes(StandardCharsets.UTF_8);
                    case "pub-url" -> pub.getBytes(StandardCharsets.UTF_8);
                    default -> throw new PluginInstallException("unexpected url " + url);
                };
            }
        };
    }

    @Test
    void installsFromGitHubWithSha256Verification(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip();
        PluginManagerService svc = service(dir, fakeClient(zip), true, "standalone");

        InstalledPlugin rec = svc.installFromGitHub("owner/acme", null, null, false);

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
        assertThrows(PluginManagerForbiddenException.class, () -> svc.installFromGitHub("owner/acme", null, null, false));
        // 一覧の読み取りは web でも可能。
        assertTrue(svc.installed().isEmpty());
    }

    @Test
    void managerDisabledForbidsInstall(@TempDir Path dir) throws Exception {
        PluginManagerService svc = service(dir, fakeClient(pluginZip()), false, "standalone");
        assertThrows(PluginManagerForbiddenException.class, () -> svc.installFromGitHub("owner/acme", null, null, false));
    }

    @Test
    void withoutUserOptInInstallIsForbidden(@TempDir Path dir) throws Exception {
        PluginManagerService svc = service(dir, fakeClient(pluginZip()), true, "standalone", false);
        assertThrows(PluginManagerForbiddenException.class, () -> svc.installFromGitHub("owner/acme", null, null, false));
        // 一覧の読み取りはオプトイン前でも可能。
        assertTrue(svc.installed().isEmpty());
    }

    // --- OS 突き合わせ（GRAPHY-Next は OS ごとにリリースが分かれるため） -------------

    /** 実行中とは別の OS だけを宣言した zip。どの OS で走らせても「非対応」になる。 */
    private static String foreignOsJson() {
        String cur = OsCompat.current();
        String other = cur.equals("win32") ? "darwin" : "win32";
        return "[\"" + other + "\"]";
    }

    @Test
    void installRejectsPluginForAnotherOs(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip(foreignOsJson(), false);
        PluginManagerService svc = service(dir, fakeClient(zip), true, "standalone");

        PluginInstallException e = assertThrows(PluginInstallException.class,
                () -> svc.installFromGitHub("owner/acme", null, null, false));
        assertTrue(e.getMessage().contains("supports OS"), e.getMessage());
        // 非対応なら展開もされない。
        assertTrue(!Files.exists(dir.resolve("acme")));
        assertTrue(svc.installed().isEmpty());
    }

    @Test
    void installAcceptsPluginDeclaringCurrentOs(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip("[\"" + OsCompat.current() + "\"]", false);
        PluginManagerService svc = service(dir, fakeClient(zip), true, "standalone");
        assertEquals("acme", svc.installFromGitHub("owner/acme", null, null, false).id());
    }

    @Test
    void inspectReportsOsMismatchBeforeInstalling(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip(foreignOsJson(), true);
        PluginManagerService svc = service(dir, fakeClient(zip), true, "standalone");

        PluginManagerService.PluginPreview p = svc.inspectGitHub("owner/acme", null);

        assertTrue(!p.osOk());
        assertTrue(!p.installable());
        assertEquals(OsCompat.current(), p.currentOs());
        assertTrue(p.graphyOk()); // OS だけが NG であることを区別できる
        // 検査では一切展開しない。
        assertTrue(!Files.exists(dir.resolve("acme")));
    }

    // --- 導入前の検査（同意画面の材料） -------------------------------------------

    @Test
    void inspectExposesContentsAndIntegrity(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip(null, true);
        PluginManagerService svc = service(dir, fakeClient(zip), true, "standalone");

        PluginManagerService.PluginPreview p = svc.inspectGitHub("owner/acme", null);

        assertEquals("acme", p.id());
        assertEquals(PluginPackage.sha256(zip), p.sha256());
        assertTrue(p.integrityVerified());          // <zip>.sha256 資産あり
        assertTrue(p.hasUi());
        assertEquals(List.of("backend.jar"), p.jars()); // アプリと同じ権限で動くコードの存在
        assertEquals(List.of("read-pixels"), p.permissions());
        assertTrue(!p.alreadyInstalled());
        assertTrue(p.installable());
    }

    /**
     * 同意画面は JSON 越しに判断するので、派生値 {@code installable} が確実に載ることを固定する。
     * record は宣言した構成要素しか直列化されず、これを取りこぼして
     * 「OS も版数も OK なのに導入できません」と表示される不具合が実際に起きた。
     */
    @Test
    void previewSerializesDerivedInstallableFlag(@TempDir Path dir) throws Exception {
        PluginManagerService svc = service(dir, fakeClient(pluginZip()), true, "standalone");

        String json = MAPPER.writeValueAsString(svc.inspectGitHub("owner/acme", null));

        assertTrue(json.contains("\"installable\":true"), json);
        assertTrue(json.contains("\"osOk\":true"), json);
    }

    @Test
    void withoutShaAssetIntegrityIsUnverifiedAndInstallNeedsAcknowledgement(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip();
        PluginManagerService svc = service(dir, clientWithoutSha(zip), true, "standalone");

        assertTrue(!svc.inspectGitHub("owner/acme", null).integrityVerified());

        PluginInstallException e = assertThrows(PluginInstallException.class,
                () -> svc.installFromGitHub("owner/acme", null, null, false));
        assertTrue(e.getMessage().contains("integrity cannot be verified"), e.getMessage());

        // 承知のうえなら導入できる。
        assertEquals("acme", svc.installFromGitHub("owner/acme", null, null, true).id());
    }

    @Test
    void installRejectsPackageThatChangedSinceReview(@TempDir Path dir) throws Exception {
        PluginManagerService svc = service(dir, fakeClient(pluginZip()), true, "standalone");
        String staleSha = PluginPackage.sha256("something else".getBytes(StandardCharsets.UTF_8));

        PluginInstallException e = assertThrows(PluginInstallException.class,
                () -> svc.installFromGitHub("owner/acme", null, staleSha, false));
        assertTrue(e.getMessage().contains("changed since it was reviewed"), e.getMessage());
        assertTrue(svc.installed().isEmpty());
    }

    @Test
    void unrelatedShaAssetIsNotUsedAsExpectedHash(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip();
        // <zip>.sha256 ではない無関係な .sha256 資産だけがあるリリース。
        GitHubReleaseClient client = new GitHubReleaseClient() {
            @Override
            public List<Release> listReleases(String repo, String token) {
                return List.of(new Release("v1.0.0", "1.0.0", "notes", "2026-01-01", false,
                        List.of(new Asset("acme.zip", "api-zip", "zip-url", zip.length),
                                new Asset("checksums-of-something-else.sha256", "api-x", "x-url", 64))));
            }

            @Override
            public byte[] download(String url, String token) {
                if ("zip-url".equals(url)) return zip;
                throw new PluginInstallException("must not download unrelated sha asset: " + url);
            }
        };
        PluginManagerService svc = service(dir, client, true, "standalone");

        // 無関係な資産は無視され、「検証できない」として扱われる（誤ったハッシュでの照合をしない）。
        assertTrue(!svc.inspectGitHub("owner/acme", null).integrityVerified());
    }

    // --- 署名（minisign）: 信頼鍵・TOFU・不正署名 ---------------------------------

    @Test
    void signedByTrustedKeyIsVerifiedAndInstallsWithoutConsent(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip();
        MinisignFixture key = new MinisignFixture("00112233445566aa");
        PluginManagerService svc = service(dir, signedClient(zip, key.sign(zip, "file:acme.zip"), key.publicKey()),
                true, "standalone", true, List.of(key.publicKey()));

        PluginManagerService.PluginPreview p = svc.inspectGitHub("owner/acme", null);

        assertEquals("trusted", p.signature());
        assertEquals("00112233445566aa", p.signerKeyId());
        assertEquals("file:acme.zip", p.signatureComment());
        assertEquals("verified", p.trust());
        // 既知の鍵で通ったので、同意画面を出さずにそのまま導入してよい。
        assertTrue(p.autoInstallable());

        InstalledPlugin rec = svc.installFromGitHub("owner/acme", null, p.sha256(), false);
        assertEquals("verified", rec.trust());
        assertEquals("00112233445566aa", rec.signerKeyId());
    }

    @Test
    void signedByUnknownKeyStillNeedsConsent(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip();
        MinisignFixture key = new MinisignFixture("00112233445566bb");
        // 本体の信頼鍵には登録していない（＝第三者プラグインの初回導入）。
        PluginManagerService svc = service(dir, signedClient(zip, key.sign(zip, "file:acme.zip"), key.publicKey()),
                true, "standalone", true, List.of());

        PluginManagerService.PluginPreview p = svc.inspectGitHub("owner/acme", null);

        assertEquals("first-use", p.signature());
        assertEquals("community", p.trust());
        assertTrue(p.installable());
        assertTrue(!p.autoInstallable()); // 初回は中身を見せて同意を取る
    }

    @Test
    void tamperedPackageWithValidLookingSignatureIsRejected(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip();
        MinisignFixture key = new MinisignFixture("00112233445566cc");
        String sig = key.sign(zip, "file:acme.zip");
        byte[] tampered = pluginZip(null, true); // JAR を仕込んだ別物にすり替える

        PluginManagerService svc = service(dir, signedClient(tampered, sig, key.publicKey()),
                true, "standalone", true, List.of(key.publicKey()));

        assertEquals("invalid", svc.inspectGitHub("owner/acme", null).signature());
        PluginInstallException e = assertThrows(PluginInstallException.class,
                () -> svc.installFromGitHub("owner/acme", null, null, true)); // 承知しても通さない
        assertTrue(e.getMessage().contains("signature check failed"), e.getMessage());
        assertTrue(svc.installed().isEmpty());
    }

    @Test
    void updateSignedByADifferentKeyIsRejected(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip();
        MinisignFixture original = new MinisignFixture("00112233445566dd");
        PluginManagerService first = service(dir, signedClient(zip, original.sign(zip, "v1"), original.publicKey()),
                true, "standalone", true, List.of());
        InstalledPlugin rec = first.installFromGitHub("owner/acme", null, null, true);
        assertEquals("00112233445566dd", rec.signerKeyId()); // 初回の鍵を固定（TOFU）

        // 乗っ取り: 別の鍵で署名し、その鍵をリリースに同梱して正当に見せかける。
        MinisignFixture attacker = new MinisignFixture("00112233445566ee");
        PluginManagerService second = service(dir, signedClient(zip, attacker.sign(zip, "v2"), attacker.publicKey()),
                true, "standalone", true, List.of());

        assertEquals("invalid", second.inspectGitHub("owner/acme", null).signature());
        PluginInstallException e = assertThrows(PluginInstallException.class,
                () -> second.installFromGitHub("owner/acme", null, null, true));
        assertTrue(e.getMessage().contains("different key"), e.getMessage());
    }

    @Test
    void updateSignedByTheSameKeyIsInstalledWithoutConsent(@TempDir Path dir) throws Exception {
        byte[] zip = pluginZip();
        MinisignFixture key = new MinisignFixture("00112233445566ff");
        PluginManagerService svc = service(dir, signedClient(zip, key.sign(zip, "v1"), key.publicKey()),
                true, "standalone", true, List.of());
        svc.installFromGitHub("owner/acme", null, null, true);

        PluginManagerService.PluginPreview p = svc.inspectGitHub("owner/acme", null);

        assertEquals("pinned", p.signature());
        assertTrue(p.autoInstallable()); // 2 回目以降は押すだけ
        assertTrue(p.alreadyInstalled());
    }

    @Test
    void unsignedReleaseIsUnchangedFromBefore(@TempDir Path dir) throws Exception {
        PluginManagerService svc = service(dir, fakeClient(pluginZip()), true, "standalone");
        PluginManagerService.PluginPreview p = svc.inspectGitHub("owner/acme", null);
        assertEquals("unsigned", p.signature());
        assertTrue(!p.autoInstallable()); // 署名が無ければ同意画面は出る
        assertTrue(p.installable());
    }

    @Test
    void statusReflectsMode(@TempDir Path dir) throws Exception {
        assertTrue(service(dir, fakeClient(pluginZip()), true, "standalone").managerStatus().canManage());
        assertTrue(!service(dir, fakeClient(pluginZip()), true, "web").managerStatus().canManage());
        assertTrue(!service(dir, fakeClient(pluginZip()), false, "standalone").managerStatus().canManage());
    }

    @Test
    void statusExposesOptInState(@TempDir Path dir) throws Exception {
        // 管理者ゲートが開いた standalone＝トグルを出すが、オプトイン前は導入不可。
        PluginManagerService before = service(dir, fakeClient(pluginZip()), true, "standalone", false);
        assertTrue(before.managerStatus().canOptIn());
        assertTrue(!before.managerStatus().installEnabled());
        assertTrue(!before.managerStatus().canManage());

        PluginManagerService after = service(dir, fakeClient(pluginZip()), true, "standalone", true);
        assertTrue(after.managerStatus().installEnabled());
        assertTrue(after.managerStatus().canManage());

        // 管理者ゲートが閉じている / web ではトグル自体を出さない。
        assertTrue(!service(dir, fakeClient(pluginZip()), false, "standalone", true).managerStatus().canOptIn());
        assertTrue(!service(dir, fakeClient(pluginZip()), true, "web", true).managerStatus().canOptIn());
    }
}
