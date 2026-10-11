/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.settings;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * アプリ設定の取得・保存。キー→値の汎用ストア。
 *
 * <p>現状はサーバーグローバル（standalone は単一ユーザーで問題なし）。web のマルチユーザー
 * では将来ユーザー単位に拡張する余地を残す。
 *
 * <p>置き場は 2 つ:
 * <ul>
 *   <li>{@code graphy.settings.global-file} 指定時（standalone で Electron が渡す）: 症例に紐づく
 *       {@link #XA_CALIBRATION_PREFIX} 以外は、DB フォルダをまたいで共通の JSON ファイルに置く。
 *       ファイルが無ければ、今の DB の値を写して作る（DB の行は消さない＝旧版に戻せる）。</li>
 *   <li>未指定（web・テスト）: すべて DB（{@code app_setting}）。</li>
 * </ul>
 */
@Service
public class SettingsService {

    /** デバッグモードのキー。値が変わったらログレベルを切り替える。 */
    public static final String DEBUG_MODE_KEY = "general.debugMode";

    /**
     * プラグイン導入のユーザーオプトイン（環境設定＞プラグインのトグル）。既定 false。
     * 設計: fw/plugin-manager-design.md §5。
     */
    public static final String PLUGIN_INSTALL_ENABLED_KEY = "plugins.installEnabled";

    /**
     * XA の空間校正（シリーズ単位）。キーは {@code xa.calibration.<SeriesInstanceUID>}。
     * 設計: fw/angio-design.md §7.4。
     *
     * <p>🚨 <b>これは環境設定ではなく症例に紐づくデータ</b>。だから
     * {@code AutomatorService.reset()} は<b>このプレフィックスだけ消す</b>——
     * 消し残すと、前の実行で確定した校正が次の実行に効いて
     * <b>「未校正なら px 表示」の検証が黙って通る</b>（ROI 保存で実際に起きた形）。
     */
    public static final String XA_CALIBRATION_PREFIX = "xa.calibration.";

    private static final Logger log = LoggerFactory.getLogger(SettingsService.class);
    private static final TypeReference<LinkedHashMap<String, String>> MAP_TYPE = new TypeReference<>() {
    };

    private final SettingRepository repo;
    private final DebugLogControl debugLogControl;
    /** 共通設定ファイル。null なら全キーを DB に置く。 */
    private final Path globalFile;
    private final ObjectMapper mapper = new ObjectMapper();

    public SettingsService(SettingRepository repo, DebugLogControl debugLogControl,
                           @Value("${graphy.settings.global-file:}") String globalFile) {
        this.repo = repo;
        this.debugLogControl = debugLogControl;
        this.globalFile = globalFile == null || globalFile.isBlank()
                ? null : Path.of(globalFile).toAbsolutePath().normalize();
    }

    /** DB に置くキーか（共通ファイル使用時は症例に紐づく校正だけ）。 */
    private boolean inDb(String key) {
        return globalFile == null || key.startsWith(XA_CALIBRATION_PREFIX);
    }

    @Transactional(readOnly = true)
    public synchronized Map<String, String> getAll() {
        Map<String, String> map = new LinkedHashMap<>();
        if (globalFile != null) {
            map.putAll(readGlobal());
        }
        for (Setting s : repo.findAll()) {
            if (s.getKey() != null && inDb(s.getKey())) {
                map.put(s.getKey(), s.getValue());
            }
        }
        return map;
    }

    /** 与えられたキーのみ上書き（部分更新・マージ）。 */
    @Transactional
    public synchronized Map<String, String> putAll(Map<String, String> updates) {
        if (updates != null) {
            Map<String, String> global = globalFile == null ? null : readGlobal();
            updates.forEach((k, v) -> {
                if (inDb(k)) {
                    Setting s = repo.findById(k).orElseGet(() -> new Setting(k));
                    s.setValue(v);
                    repo.save(s);
                } else {
                    global.put(k, v);
                }
            });
            if (global != null) {
                writeGlobal(global);
            }
            // デバッグモードが変わったらログレベルを即時反映
            if (updates.containsKey(DEBUG_MODE_KEY)) {
                debugLogControl.apply(Boolean.parseBoolean(updates.get(DEBUG_MODE_KEY)));
            }
        }
        return getAll();
    }

    /**
     * プレフィックスに一致するキーを消す（症例に紐づく設定の後始末用）。
     *
     * @return 消した件数
     */
    @Transactional
    public synchronized int deleteByPrefix(String prefix) {
        if (prefix == null || prefix.isBlank()) {
            return 0;
        }
        List<Setting> hit = new ArrayList<>();
        for (Setting s : repo.findAll()) {
            if (s.getKey() != null && s.getKey().startsWith(prefix) && inDb(s.getKey())) {
                hit.add(s);
            }
        }
        repo.deleteAll(hit);
        int n = hit.size();
        if (globalFile != null) {
            Map<String, String> global = readGlobal();
            int size = global.size();
            if (global.keySet().removeIf(k -> k.startsWith(prefix))) {
                n += size - global.size();
                writeGlobal(global);
            }
        }
        return n;
    }

    /**
     * キーを完全一致で消す（前方一致の {@link #deleteByPrefix} だと {@code ...1.2.3} が {@code ...1.2.34} も消す）。
     *
     * @return 消した件数
     */
    @Transactional
    public synchronized int deleteKeys(java.util.Collection<String> keys) {
        int n = 0;
        Map<String, String> global = globalFile == null ? null : readGlobal();
        for (String k : keys) {
            if (k == null) {
                continue;
            }
            if (inDb(k)) {
                if (repo.existsById(k)) {
                    repo.deleteById(k);
                    n++;
                }
            } else if (global.containsKey(k)) {
                global.remove(k);
                n++;
            }
        }
        if (global != null) {
            writeGlobal(global);
        }
        return n;
    }

    /**
     * 共通ファイルを読む。無ければ今の DB の値（校正以外）から作る。
     * 読めない（壊れた）ファイルは消さずに {@code .corrupt-<日時>} へ退けてから作り直す。
     */
    private Map<String, String> readGlobal() {
        if (Files.exists(globalFile)) {
            try {
                Map<String, String> m = mapper.readValue(globalFile.toFile(), MAP_TYPE);
                return m == null ? new LinkedHashMap<>() : m;
            } catch (IOException e) {
                Path aside = globalFile.resolveSibling(globalFile.getFileName() + ".corrupt-"
                        + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")));
                log.error("共通設定ファイルを読めません。{} へ退けて、DB の値から作り直します: {}", aside, e.toString());
                try {
                    Files.move(globalFile, aside);
                } catch (IOException moveErr) {
                    throw new UncheckedIOException("共通設定ファイルを退避できません: " + globalFile, moveErr);
                }
            }
        }
        Map<String, String> seeded = new LinkedHashMap<>();
        for (Setting s : repo.findAll()) {
            if (s.getKey() != null && !s.getKey().startsWith(XA_CALIBRATION_PREFIX)) {
                seeded.put(s.getKey(), s.getValue());
            }
        }
        writeGlobal(seeded);
        log.info("共通設定ファイルを作成しました（DB から {} 件）: {}", seeded.size(), globalFile);
        return seeded;
    }

    /** 一時ファイルに書いて置き換える（途中で落ちても元のファイルが残る）。所有者だけが読める権限にする。 */
    private void writeGlobal(Map<String, String> m) {
        try {
            Files.createDirectories(globalFile.getParent());
            Path tmp = Files.createTempFile(globalFile.getParent(), ".settings-", ".tmp");
            try {
                try {
                    Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-------"));
                } catch (UnsupportedOperationException ignored) {
                    // Windows は POSIX 権限が無い（ユーザープロファイル配下の ACL に任せる）
                }
                mapper.writerWithDefaultPrettyPrinter().writeValue(tmp.toFile(), m);
                try {
                    Files.move(tmp, globalFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException e) {
                    Files.move(tmp, globalFile, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(tmp);
            }
        } catch (IOException e) {
            throw new UncheckedIOException("共通設定ファイルを保存できません: " + globalFile, e);
        }
    }
}
