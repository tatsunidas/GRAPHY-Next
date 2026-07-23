/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.plugin.PluginProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Optional;

/**
 * プラグインマネージャの取りまとめ（取得元の解決＋ライフサイクル）。
 *
 * <p>導入系（install / update / reinstall / enable / disable / uninstall）は
 * standalone かつ {@code graphy.plugins.manager-enabled=true} のときのみ許可する。
 * web は共有サーバーのため運営キュレーション前提で 403（設計: fw/plugin-manager-design.md §web）。
 * 一覧取得は常に可能。
 */
@Service
public class PluginManagerService {

    private static final Logger log = LoggerFactory.getLogger(PluginManagerService.class);

    private final PluginProperties props;
    private final GitHubReleaseClient github;
    private final Environment env;
    private final PluginInstaller installer;

    public PluginManagerService(PluginProperties props,
                                ObjectMapper mapper,
                                GitHubReleaseClient github,
                                Environment env,
                                @Value("${graphy.version:dev}") String coreVersion) {
        this.props = props;
        this.github = github;
        this.env = env;
        Path dir = Path.of(props.getDir() == null || props.getDir().isBlank() ? "./plugins" : props.getDir())
                .toAbsolutePath().normalize();
        this.installer = new PluginInstaller(dir, mapper, coreVersion);
    }

    /** 導入済み一覧（台帳）。読み取りは常に可能。 */
    public List<InstalledPlugin> installed() {
        return installer.installed();
    }

    /** マネージャの状態（フロントが導入 UI を出すか判断するため）。 */
    public ManagerStatus managerStatus() {
        return new ManagerStatus(canMutate(), isStandalone(), props.isManagerEnabled(),
                props.getGithubToken() != null && !props.getGithubToken().isBlank());
    }

    /** {@code owner/repo} の互換フィルタ済みバージョン一覧（新しい順）。 */
    public List<AvailableVersion> versions(String repo) {
        requireMutable(); // ネットワーク取得を伴うため導入可能時のみ
        List<GitHubReleaseClient.Release> rels = github.listReleases(repo, token());
        return rels.stream()
                .sorted(byTagDesc())
                .map(r -> new AvailableVersion(
                        r.tagName(), r.publishedAt(), r.prerelease(),
                        findZipAsset(r).map(GitHubReleaseClient.Asset::name).orElse(null)))
                .toList();
    }

    /** GitHub Release からインストール（version 未指定なら最新の非 prerelease）。 */
    public InstalledPlugin installFromGitHub(String repo, String version) throws IOException {
        requireMutable();
        List<GitHubReleaseClient.Release> rels = github.listReleases(repo, token());
        if (rels.isEmpty()) throw new PluginInstallException("no releases for " + repo);
        GitHubReleaseClient.Release rel = pickRelease(rels, version)
                .orElseThrow(() -> new PluginInstallException(
                        "no matching release for " + repo + (version == null ? "" : " @ " + version)));
        GitHubReleaseClient.Asset zip = findZipAsset(rel)
                .orElseThrow(() -> new PluginInstallException(
                        "release " + rel.tagName() + " has no .zip asset"));
        String expectedSha = fetchSha256(rel, zip);
        byte[] bytes = github.download(downloadUrl(zip), token());
        // 公式索引由来のみ verified、その他は community 扱い（署名検証は P2）。
        return installer.install(bytes, new InstalledPlugin.Source("github", repo), expectedSha, "community");
    }

    /** ローカル zip（オフライン/エアギャップ導入）。 */
    public InstalledPlugin installFromFile(byte[] zip, String filename) throws IOException {
        requireMutable();
        return installer.install(zip, new InstalledPlugin.Source("file", filename), null, "local");
    }

    /** 現行バージョンを取得元から再取得（破損修復）。file 由来は再アップロードが必要。 */
    public InstalledPlugin reinstall(String id) throws IOException {
        requireMutable();
        InstalledPlugin cur = installer.installed().stream()
                .filter(p -> p.id().equals(id)).findFirst()
                .orElseThrow(() -> new NoSuchElementException("plugin not installed: " + id));
        InstalledPlugin.Source src = cur.source();
        if (src != null && "github".equals(src.type())) {
            return installFromGitHub(src.ref(), cur.version());
        }
        throw new PluginInstallException("reinstall unsupported for source '"
                + (src == null ? "?" : src.type()) + "': re-upload the zip");
    }

    public void enable(String id) throws IOException {
        requireMutable();
        installer.setEnabled(id, true);
    }

    public void disable(String id) throws IOException {
        requireMutable();
        installer.setEnabled(id, false);
    }

    public boolean uninstall(String id) throws IOException {
        requireMutable();
        return installer.uninstall(id);
    }

    // --- 取得元の解決ヘルパ -------------------------------------------------

    private Optional<GitHubReleaseClient.Release> pickRelease(
            List<GitHubReleaseClient.Release> rels, String version) {
        if (version != null && !version.isBlank()) {
            String want = version.trim();
            String wantNoV = want.startsWith("v") || want.startsWith("V") ? want.substring(1) : want;
            return rels.stream().filter(r -> {
                String tag = r.tagName() == null ? "" : r.tagName();
                String tagNoV = tag.startsWith("v") || tag.startsWith("V") ? tag.substring(1) : tag;
                return tag.equals(want) || tagNoV.equals(wantNoV);
            }).findFirst();
        }
        // 最新の非 prerelease を semver 降順で。無ければ何でも先頭。
        return rels.stream().filter(r -> !r.prerelease()).max(bySemverAsc())
                .or(() -> rels.stream().findFirst());
    }

    private Optional<GitHubReleaseClient.Asset> findZipAsset(GitHubReleaseClient.Release r) {
        return r.assets().stream()
                .filter(a -> a.name() != null && a.name().toLowerCase().endsWith(".zip"))
                .findFirst();
    }

    /** {@code <zip>.sha256} 資産があれば取得し、先頭トークン（hex）を期待値として返す。 */
    private String fetchSha256(GitHubReleaseClient.Release rel, GitHubReleaseClient.Asset zip) {
        Optional<GitHubReleaseClient.Asset> shaAsset = rel.assets().stream()
                .filter(a -> a.name() != null
                        && (a.name().equalsIgnoreCase(zip.name() + ".sha256")
                            || a.name().toLowerCase().endsWith(".sha256")))
                .findFirst();
        if (shaAsset.isEmpty()) return null;
        try {
            byte[] body = github.download(downloadUrl(shaAsset.get()), token());
            String content = new String(body, StandardCharsets.UTF_8).trim();
            if (content.isEmpty()) return null;
            return content.split("\\s+")[0]; // "<hex>  filename" 形式に対応
        } catch (RuntimeException e) {
            log.warn("[plugin-manager] sha256 asset unreadable, skipping integrity check: {}", e.getMessage());
            return null;
        }
    }

    private String downloadUrl(GitHubReleaseClient.Asset asset) {
        // token があれば private でも取れる API URL を優先、無ければ公開 URL。
        if (token() != null && asset.apiUrl() != null) return asset.apiUrl();
        return asset.browserUrl() != null ? asset.browserUrl() : asset.apiUrl();
    }

    private static Comparator<GitHubReleaseClient.Release> bySemverAsc() {
        return Comparator.comparing(r -> {
            try {
                return SemVer.parse(r.tagName());
            } catch (RuntimeException e) {
                return SemVer.parse("0.0.0");
            }
        });
    }

    private static Comparator<GitHubReleaseClient.Release> byTagDesc() {
        return bySemverAsc().reversed();
    }

    // --- モードゲート -------------------------------------------------------

    private String token() {
        String t = props.getGithubToken();
        return t == null || t.isBlank() ? null : t;
    }

    private boolean isStandalone() {
        return Arrays.asList(env.getActiveProfiles()).contains("standalone");
    }

    private boolean canMutate() {
        return props.isManagerEnabled() && isStandalone();
    }

    private void requireMutable() {
        if (!canMutate()) {
            throw new PluginManagerForbiddenException(
                    "plugin install/manage is disabled in this mode (standalone + graphy.plugins.manager-enabled required)");
        }
    }

    /** マネージャの可否状態。 */
    public record ManagerStatus(boolean canManage, boolean standalone,
                                boolean managerEnabled, boolean hasGithubToken) {}

    /** 取得可能なバージョン（互換情報は導入時に判定）。 */
    public record AvailableVersion(String tag, String publishedAt, boolean prerelease, String zipAsset) {}
}
