/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * フォルダ走査で共通する処理（マニフェスト読取・UI 配信）をまとめた基底。
 *
 * <p>レイアウト: {@code <root>/<pluginFolder>/plugin.json}（＋任意で {@code ui.js} / {@code *.jar}）。
 * バックエンド実行 {@link #run} はモードごとに差があるためサブクラスで実装する。
 */
abstract class FileSystemPluginRegistry implements PluginRegistry {

    private static final Logger log = LoggerFactory.getLogger(FileSystemPluginRegistry.class);
    private static final String MANIFEST_FILE = "plugin.json";

    private final ObjectMapper mapper;
    private final boolean enabled;
    private final Path root;

    protected FileSystemPluginRegistry(ObjectMapper mapper, boolean enabled, String dir) {
        this.mapper = mapper;
        this.enabled = enabled;
        this.root = Path.of(dir == null || dir.isBlank() ? "./plugins" : dir).toAbsolutePath().normalize();
        log.info("[plugins] {} registry root={} enabled={}", modeName(), root, enabled);
    }

    /** ログ用のモード名。 */
    protected abstract String modeName();

    @Override
    public List<PluginManifest> manifests() {
        List<PluginManifest> out = new ArrayList<>();
        for (Discovered d : discoverAll()) {
            out.add(toManifest(d.descriptor()));
        }
        return out;
    }

    @Override
    public Optional<byte[]> uiBundle(String id) {
        Optional<Discovered> found = discover(id);
        if (found.isEmpty()) return Optional.empty();
        Discovered d = found.get();
        String ui = d.descriptor().ui();
        if (ui == null || ui.isBlank()) return Optional.empty();
        // ui はフォルダ直下のファイル名に限定（パストラバーサル防止）。
        Path file = d.dir().resolve(ui).normalize();
        if (!file.startsWith(d.dir()) || !Files.isRegularFile(file)) {
            log.warn("[plugins] ui bundle not found or outside plugin dir: {}", file);
            return Optional.empty();
        }
        try {
            return Optional.of(Files.readAllBytes(file));
        } catch (IOException e) {
            log.warn("[plugins] failed to read ui bundle {}: {}", file, e.getMessage());
            return Optional.empty();
        }
    }

    /** id に一致するプラグインを探す（フォルダ実体経由なので id はパスに直結しない）。 */
    protected Optional<Discovered> discover(String id) {
        if (id == null || id.isBlank()) return Optional.empty();
        return discoverAll().stream().filter(d -> id.equals(d.descriptor().id())).findFirst();
    }

    /** root 直下の各フォルダを走査し、plugin.json を読めたものを返す。 */
    protected List<Discovered> discoverAll() {
        if (!enabled || !Files.isDirectory(root)) return List.of();
        List<Discovered> out = new ArrayList<>();
        try (Stream<Path> dirs = Files.list(root)) {
            for (Path dir : (Iterable<Path>) dirs.filter(Files::isDirectory)::iterator) {
                Path manifest = dir.resolve(MANIFEST_FILE);
                if (!Files.isRegularFile(manifest)) continue;
                try {
                    PluginDescriptor desc = mapper.readValue(manifest.toFile(), PluginDescriptor.class);
                    if (desc.id() == null || desc.id().isBlank()) {
                        log.warn("[plugins] skip {}: missing id", manifest);
                        continue;
                    }
                    out.add(new Discovered(dir, desc));
                } catch (IOException e) {
                    log.warn("[plugins] skip {}: {}", manifest, e.getMessage());
                }
            }
        } catch (IOException e) {
            log.warn("[plugins] failed to list {}: {}", root, e.getMessage());
        }
        return out;
    }

    /** ディスク記述 → 配信マニフェスト。UI があれば bundleUrl を API パスに向ける。 */
    private PluginManifest toManifest(PluginDescriptor d) {
        PluginManifest.Frontend fe = null;
        if (d.contributes() != null && !d.contributes().isEmpty()) {
            String bundleUrl = (d.ui() != null && !d.ui().isBlank())
                    ? "/api/plugins/" + d.id() + "/ui.js"
                    : null;
            fe = new PluginManifest.Frontend(bundleUrl, d.contributes());
        }
        PluginManifest.Backend be = (d.entrypoint() != null && !d.entrypoint().isBlank())
                ? new PluginManifest.Backend(d.entrypoint(), d.permissions())
                : null;
        return new PluginManifest(d.id(), d.name(), d.version(), fe, be);
    }

    /** 走査で見つかった 1 プラグイン（フォルダ + 記述）。 */
    protected record Discovered(Path dir, PluginDescriptor descriptor) {}
}
