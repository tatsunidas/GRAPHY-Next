/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

/**
 * 起動時に、インストーラに同梱した公式プラグインを入れる（fw/plugin-manager-design.md §10）。
 *
 * <p>同梱の置き場は {@code graphy.plugins.bundled-dir}（desktop の main が、配布物の
 * {@code resources/bundled-plugins} があるときだけ渡す）。空なら何もしない（開発・web）。
 * 1 つ失敗しても残りは続け、起動は止めない（同梱は付録で、本体の起動より大事ではない）。
 */
@Component
@Profile("standalone")
public class BundledPluginInstaller implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(BundledPluginInstaller.class);

    private final PluginManagerService manager;
    private final String bundledDir;

    public BundledPluginInstaller(PluginManagerService manager,
                                  @Value("${graphy.plugins.bundled-dir:}") String bundledDir) {
        this.manager = manager;
        this.bundledDir = bundledDir;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (bundledDir == null || bundledDir.isBlank()) return;
        Path dir = Path.of(bundledDir);
        if (!Files.isDirectory(dir)) return;
        List<Path> zips;
        try (Stream<Path> s = Files.list(dir)) {
            zips = s.filter(p -> p.getFileName().toString().toLowerCase().endsWith(".zip")).sorted().toList();
        } catch (IOException e) {
            log.warn("[plugin-manager] bundled plugins unreadable: {}", e.getMessage());
            return;
        }
        for (Path zip : zips) {
            try {
                PluginManagerService.BundledOutcome r = manager.installBundled(zip);
                log.info("[plugin-manager] bundled {} {}: {}", r.id(), r.version(), r.installed() ? r.reason() : "skipped (" + r.reason() + ")");
            } catch (RuntimeException | IOException e) {
                log.warn("[plugin-manager] bundled plugin {} failed: {}", zip.getFileName(), e.getMessage());
            }
        }
    }
}
