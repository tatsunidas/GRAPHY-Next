/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.plugin.PluginDescriptor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * プラグインの導入・削除・有効無効を司るコア（Spring 非依存＝単体テスト可能）。
 *
 * <p>導入フロー: sha256 検証 → plugin.json 読取 → id 検証 → コア互換判定 → 一時展開 →
 * 原子的に差し替え → 台帳更新。zip slip / パストラバーサルは {@link PluginPackage} と id 検証で防ぐ。
 * 設計: fw/plugin-manager-design.md。
 */
public class PluginInstaller {

    private static final Logger log = LoggerFactory.getLogger(PluginInstaller.class);
    private static final Pattern ID_PATTERN = Pattern.compile("[A-Za-z0-9._-]+");
    /**
     * 無効化マーカーのファイル名。<b>{@code FileSystemPluginRegistry.DISABLED_MARKER} と一致必須</b>
     * （リポジトリの pinned-literal 規約に倣った意図的な重複。走査側とここで同じ文字列を使う）。
     */
    private static final String DISABLED_MARKER = ".disabled";

    private final Path pluginsDir;
    private final ObjectMapper mapper;
    private final String coreVersion;
    private final PluginLedger ledger;

    public PluginInstaller(Path pluginsDir, ObjectMapper mapper, String coreVersion) {
        this.pluginsDir = pluginsDir.toAbsolutePath().normalize();
        this.mapper = mapper;
        this.coreVersion = coreVersion;
        this.ledger = new PluginLedger(this.pluginsDir.resolve("installed.json"), mapper);
    }

    /** 台帳（導入済み一覧）。 */
    public List<InstalledPlugin> installed() {
        return ledger.readAll();
    }

    /**
     * zip バイト列からプラグインを導入する（既存 id は置換＝更新/再インストール兼用）。
     *
     * @param zip            プラグイン配布 zip
     * @param source         取得元（github / file）
     * @param expectedSha256 期待する sha256（null なら検証しない）
     * @param trust          信頼ティア（verified / community / local）
     * @throws PluginInstallException 検証に失敗（sha256 不一致・非互換・不正 zip・不正 id）
     */
    public InstalledPlugin install(byte[] zip, InstalledPlugin.Source source, String expectedSha256, String trust)
            throws IOException {
        String sha = PluginPackage.sha256(zip);
        if (expectedSha256 != null && !expectedSha256.isBlank()
                && !expectedSha256.trim().equalsIgnoreCase(sha)) {
            throw new PluginInstallException("sha256 mismatch: expected " + expectedSha256 + " but got " + sha);
        }
        String base = PluginPackage.manifestBasePrefix(zip);
        PluginDescriptor desc = PluginPackage.readDescriptor(zip, base, mapper);
        validateId(desc.id());
        checkCompat(desc);

        Files.createDirectories(pluginsDir);
        Path target = pluginsDir.resolve(desc.id()).normalize();
        if (!target.startsWith(pluginsDir)) {
            throw new PluginInstallException("resolved target escapes plugins dir: " + desc.id());
        }

        Path tmp = Files.createTempDirectory(pluginsDir, ".install-" + desc.id() + "-");
        try {
            PluginPackage.extract(zip, base, tmp);
            deleteRecursively(target);
            try {
                Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicFailed) {
                Files.move(tmp, target); // 環境により ATOMIC_MOVE 非対応 → 通常 move にフォールバック
            }
        } finally {
            deleteRecursively(tmp); // move 成功後は既に無い。失敗時のみ掃除。
        }

        InstalledPlugin rec = new InstalledPlugin(
                desc.id(), desc.name(), desc.version(), source, sha,
                true, false, Instant.now().toString(), trust == null ? "community" : trust);
        ledger.upsert(rec);
        Files.deleteIfExists(target.resolve(DISABLED_MARKER));
        log.info("[plugin-manager] installed {} v{} from {} ({})",
                rec.id(), rec.version(), source == null ? "?" : source.type(), rec.trust());
        return rec;
    }

    /** プラグインを削除（フォルダ＋台帳）。存在しなければ false。 */
    public boolean uninstall(String id) throws IOException {
        validateId(id);
        Path target = pluginsDir.resolve(id).normalize();
        if (!target.startsWith(pluginsDir)) throw new PluginInstallException("invalid id: " + id);
        boolean existed = Files.isDirectory(target) || ledger.find(id).isPresent();
        deleteRecursively(target);
        ledger.remove(id);
        if (existed) log.info("[plugin-manager] uninstalled {}", id);
        return existed;
    }

    /** 有効/無効を切り替える（{@code .disabled} マーカー＋台帳）。 */
    public void setEnabled(String id, boolean enabled) throws IOException {
        validateId(id);
        Path target = pluginsDir.resolve(id).normalize();
        if (!target.startsWith(pluginsDir) || !Files.isDirectory(target)) {
            throw new NoSuchElementException("plugin not installed: " + id);
        }
        Path marker = target.resolve(DISABLED_MARKER);
        if (enabled) {
            Files.deleteIfExists(marker);
        } else {
            Files.writeString(marker, "disabled by plugin-manager\n");
        }
        ledger.setEnabled(id, enabled);
    }

    private void checkCompat(PluginDescriptor desc) {
        String range = desc.engines() == null ? null : desc.engines().get("graphy");
        if (!SemVer.satisfies(coreVersion, range)) {
            throw new PluginInstallException(
                    "incompatible: plugin requires graphy " + range + " but core is " + coreVersion);
        }
    }

    private static void validateId(String id) {
        if (id == null || id.isBlank() || !ID_PATTERN.matcher(id).matches()
                || id.equals(".") || id.equals("..")) {
            throw new PluginInstallException("invalid plugin id: " + id);
        }
    }

    private static void deleteRecursively(Path path) throws IOException {
        if (!Files.exists(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return;
        try (Stream<Path> walk = Files.walk(path)) {
            for (Path p : (Iterable<Path>) walk.sorted(Comparator.reverseOrder())::iterator) {
                Files.deleteIfExists(p);
            }
        }
    }
}
