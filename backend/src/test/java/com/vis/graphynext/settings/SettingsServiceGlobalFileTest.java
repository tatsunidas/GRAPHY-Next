/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.settings;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 共通設定ファイル: DB フォルダを切り替えても環境設定は同じ、XA 校正だけは DB ごと。
 */
class SettingsServiceGlobalFileTest {

    private static final String CALIB = SettingsService.XA_CALIBRATION_PREFIX + "1.2.3";

    /** app_setting を Map で模した DB（1 つの DB フォルダに相当）。 */
    private static final class Db {
        final Map<String, String> rows = new LinkedHashMap<>();
        final SettingRepository repo = mock(SettingRepository.class);

        Db(Map<String, String> initial) {
            rows.putAll(initial);
            when(repo.findAll()).thenAnswer(i -> {
                List<Setting> out = new ArrayList<>();
                rows.forEach((k, v) -> {
                    Setting s = new Setting(k);
                    s.setValue(v);
                    out.add(s);
                });
                return out;
            });
            when(repo.findById(anyString())).thenAnswer(i -> {
                String k = i.getArgument(0);
                if (!rows.containsKey(k)) {
                    return Optional.empty();
                }
                Setting s = new Setting(k);
                s.setValue(rows.get(k));
                return Optional.of(s);
            });
            when(repo.save(any(Setting.class))).thenAnswer(i -> {
                Setting s = i.getArgument(0);
                rows.put(s.getKey(), s.getValue());
                return s;
            });
            org.mockito.Mockito.doAnswer(i -> {
                Collection<Setting> c = i.getArgument(0);
                c.forEach(s -> rows.remove(s.getKey()));
                return null;
            }).when(repo).deleteAll(any(Iterable.class));
        }

        SettingsService service(Path globalFile) {
            return new SettingsService(repo, new DebugLogControl(), globalFile == null ? "" : globalFile.toString());
        }
    }

    @Test
    void 共通ファイル未指定なら従来どおり全キーをDBに置く(@TempDir Path dir) {
        Db db = new Db(Map.of());
        SettingsService s = db.service(null);
        s.putAll(Map.of("ui.theme", "dark", CALIB, "0.3"));

        assertEquals(Map.of("ui.theme", "dark", CALIB, "0.3"), db.rows);
        assertEquals(1, s.deleteByPrefix(SettingsService.XA_CALIBRATION_PREFIX));
        assertEquals(Map.of("ui.theme", "dark"), db.rows);
    }

    @Test
    void 初回は今のDBから校正以外を写し_DBの行は消さない(@TempDir Path dir) throws IOException {
        Db db = new Db(Map.of("ui.theme", "dark", "dicom.localAe", "X", CALIB, "0.3"));
        Path file = dir.resolve("日本語 dir/settings.json");
        SettingsService s = db.service(file);

        Map<String, String> all = s.getAll();
        assertEquals("dark", all.get("ui.theme"));
        assertEquals("0.3", all.get(CALIB));
        String json = Files.readString(file);
        assertTrue(json.contains("ui.theme") && json.contains("dicom.localAe"));
        assertFalse(json.contains("xa.calibration"), "校正は症例データなので共通ファイルに入れない");
        assertEquals(3, db.rows.size(), "旧版に戻せるよう DB の行は残す");
    }

    @Test
    void DBを切り替えても環境設定は共通_校正はDBごと(@TempDir Path dir) {
        Path file = dir.resolve("settings.json");
        Db a = new Db(Map.of("ui.theme", "light"));
        a.service(file).putAll(Map.of("ui.theme", "dark", CALIB, "0.3"));
        assertEquals("light", a.rows.get("ui.theme"), "共通ファイル使用中は環境設定を DB に書かない");

        Db b = new Db(Map.of("ui.theme", "light"));   // 別の DB フォルダ（古い値を持つ）
        Map<String, String> inB = b.service(file).getAll();
        assertEquals("dark", inB.get("ui.theme"), "B でも A で変えた値");
        assertNull(inB.get(CALIB), "校正は A の DB にだけある");

        b.service(file).putAll(Map.of(CALIB, "0.5"));
        assertEquals("0.3", a.service(file).getAll().get(CALIB));
        assertEquals("0.5", b.service(file).getAll().get(CALIB));
    }

    @Test
    void 校正の一括削除はDBの校正だけを消す(@TempDir Path dir) {
        Path file = dir.resolve("settings.json");
        Db db = new Db(Map.of(CALIB, "0.3", SettingsService.XA_CALIBRATION_PREFIX + "9", "1"));
        SettingsService s = db.service(file);
        s.putAll(Map.of("ui.theme", "dark"));

        assertEquals(2, s.deleteByPrefix(SettingsService.XA_CALIBRATION_PREFIX));
        assertEquals(Map.of("ui.theme", "dark"), s.getAll());
        assertEquals(1, s.deleteByPrefix("ui."));
        assertEquals(Map.of(), s.getAll());
    }

    @Test
    void 壊れたファイルは消さずに退けてDBから作り直す(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("settings.json");
        Files.writeString(file, "{ broken");
        Db db = new Db(Map.of("ui.theme", "dark"));

        assertEquals("dark", db.service(file).getAll().get("ui.theme"));
        try (var ls = Files.list(dir)) {
            List<Path> aside = ls.filter(p -> p.getFileName().toString().startsWith("settings.json.corrupt-")).toList();
            assertEquals(1, aside.size());
            assertEquals("{ broken", Files.readString(aside.get(0)));
        }
    }

    @Test
    void ファイルは所有者だけが読める(@TempDir Path dir) throws IOException {
        if (!FileSystems.getDefault().supportedFileAttributeViews().contains("posix")) {
            return;
        }
        Path file = dir.resolve("settings.json");
        new Db(Map.of()).service(file).putAll(Map.of("dicom.tls", "{\"keyStorePassword\":\"x\"}"));
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(file)));
    }
}
