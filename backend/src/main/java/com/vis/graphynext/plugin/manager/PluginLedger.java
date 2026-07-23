/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * インストール台帳（{@code <pluginsDir>/installed.json}）の読み書き。
 *
 * <p>単一ファイルの JSON 配列。破損時はログを出して空扱いにし、アプリを止めない。
 * 単純のためファイル全体をロック（{@code synchronized}）して読み書きする。
 */
class PluginLedger {

    private static final Logger log = LoggerFactory.getLogger(PluginLedger.class);

    private final Path file;
    private final ObjectMapper mapper;

    PluginLedger(Path file, ObjectMapper mapper) {
        this.file = file;
        this.mapper = mapper;
    }

    synchronized List<InstalledPlugin> readAll() {
        if (!Files.isRegularFile(file)) return new ArrayList<>();
        try {
            List<InstalledPlugin> list = mapper.readValue(file.toFile(), new TypeReference<List<InstalledPlugin>>() {});
            return list == null ? new ArrayList<>() : new ArrayList<>(list);
        } catch (IOException e) {
            log.warn("[plugin-manager] installed.json unreadable ({}), treating as empty", e.getMessage());
            return new ArrayList<>();
        }
    }

    synchronized Optional<InstalledPlugin> find(String id) {
        return readAll().stream().filter(p -> p.id().equals(id)).findFirst();
    }

    synchronized void upsert(InstalledPlugin rec) {
        List<InstalledPlugin> list = readAll();
        list.removeIf(p -> p.id().equals(rec.id()));
        list.add(rec);
        writeAll(list);
    }

    synchronized void remove(String id) {
        List<InstalledPlugin> list = readAll();
        if (list.removeIf(p -> p.id().equals(id))) writeAll(list);
    }

    synchronized void setEnabled(String id, boolean enabled) {
        List<InstalledPlugin> list = readAll();
        boolean changed = false;
        for (int i = 0; i < list.size(); i++) {
            InstalledPlugin p = list.get(i);
            if (p.id().equals(id) && p.enabled() != enabled) {
                list.set(i, new InstalledPlugin(p.id(), p.name(), p.version(), p.source(),
                        p.sha256(), enabled, p.pinned(), p.installedAt(), p.trust()));
                changed = true;
            }
        }
        if (changed) writeAll(list);
    }

    private void writeAll(List<InstalledPlugin> list) {
        try {
            Files.createDirectories(file.getParent());
            byte[] json = mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(list);
            // まず temp に書いてから原子的に置換（途中クラッシュで台帳が壊れないように）。
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            Files.write(tmp, json);
            Files.move(tmp, file, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            log.error("[plugin-manager] failed to write installed.json: {}", e.getMessage());
            throw new PluginInstallException("failed to persist ledger: " + e.getMessage());
        }
    }
}
