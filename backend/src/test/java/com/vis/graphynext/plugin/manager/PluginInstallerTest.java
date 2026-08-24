/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link PluginInstaller} のコア（zip 検証・展開・台帳・有効無効・削除）を、
 * メモリ上で組んだ zip と一時ディレクトリで検証する（ネットワーク非依存）。
 */
class PluginInstallerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final InstalledPlugin.Source SRC = new InstalledPlugin.Source("file", "test.zip");

    private PluginInstaller installer(Path dir, String coreVersion) {
        return new PluginInstaller(dir, MAPPER, coreVersion);
    }

    /** 直下に plugin.json を持つ zip を作る。 */
    private static byte[] zip(Map<String, byte[]> entries) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
            for (Map.Entry<String, byte[]> e : entries.entrySet()) {
                zos.putNextEntry(new ZipEntry(e.getKey()));
                zos.write(e.getValue());
                zos.closeEntry();
            }
        }
        return baos.toByteArray();
    }

    private static String manifest(String id, String enginesRange) {
        String engines = enginesRange == null ? "" : ",\"engines\":{\"graphy\":\"" + enginesRange + "\"}";
        return "{\"id\":\"" + id + "\",\"name\":\"" + id + "\",\"version\":\"1.0.0\","
                + "\"contributes\":[\"viewer2d.menu\"],\"ui\":\"ui.js\"" + engines + "}";
    }

    private static Map<String, byte[]> flat(String id, String enginesRange) {
        Map<String, byte[]> m = new LinkedHashMap<>();
        m.put("plugin.json", manifest(id, enginesRange).getBytes(StandardCharsets.UTF_8));
        m.put("ui.js", "export function activate(h){}".getBytes(StandardCharsets.UTF_8));
        return m;
    }

    /**
     * 同梱 JAR を台帳に記録する。フロントはこれを見て「反映に再起動が要るか」を決めるので
     * （JAR ありはクラスローダのキャッシュにより再起動必須・UI のみは画面リロードで足りる）、
     * 記録が落ちると再起動バナーが出ず、更新したのに古い JAR が動き続ける。
     */
    @Test
    void recordsBundledJarsInLedger(@TempDir Path dir) throws Exception {
        Map<String, byte[]> withJar = flat("hello", null);
        withJar.put("backend.jar", "not really a jar".getBytes(StandardCharsets.UTF_8));

        InstalledPlugin rec = installer(dir, "0.2.5").install(zip(withJar), SRC, null, "local");
        assertEquals(List.of("backend.jar"), rec.jars());
        // 台帳から読み直しても保持されること（再起動判定はこちらを使う）。
        assertEquals(List.of("backend.jar"), installer(dir, "0.2.5").installed().get(0).jars());

        // UI のみなら空＝再起動不要。
        InstalledPlugin uiOnly = installer(dir, "0.2.5").install(zip(flat("uionly", null)), SRC, null, "local");
        assertTrue(uiOnly.jars().isEmpty());
    }

    @Test
    void installsFlatZip(@TempDir Path dir) throws Exception {
        InstalledPlugin rec = installer(dir, "0.2.5").install(zip(flat("hello", null)), SRC, null, "local");

        assertEquals("hello", rec.id());
        assertTrue(rec.enabled());
        assertEquals("local", rec.trust());
        assertTrue(Files.isRegularFile(dir.resolve("hello/plugin.json")), "manifest extracted");
        assertTrue(Files.isRegularFile(dir.resolve("hello/ui.js")), "ui extracted");
        assertTrue(Files.isRegularFile(dir.resolve("installed.json")), "ledger written");
        assertEquals(1, installer(dir, "0.2.5").installed().size());
    }

    @Test
    void stripsSingleWrapperFolder(@TempDir Path dir) throws Exception {
        // GitHub source-zip 風の "repo-1.0.0/" ラップを剥がして展開できること。
        Map<String, byte[]> m = new LinkedHashMap<>();
        m.put("hello-1.0.0/plugin.json", manifest("hello", null).getBytes(StandardCharsets.UTF_8));
        m.put("hello-1.0.0/ui.js", "x".getBytes(StandardCharsets.UTF_8));
        installer(dir, "0.2.5").install(zip(m), SRC, null, "local");

        assertTrue(Files.isRegularFile(dir.resolve("hello/plugin.json")));
        assertTrue(Files.isRegularFile(dir.resolve("hello/ui.js")));
        assertFalse(Files.exists(dir.resolve("hello/hello-1.0.0")), "wrapper prefix stripped");
    }

    @Test
    void rejectsMissingPluginJson(@TempDir Path dir) throws Exception {
        Map<String, byte[]> m = new LinkedHashMap<>();
        m.put("ui.js", "x".getBytes(StandardCharsets.UTF_8));
        byte[] bad = zip(m);
        assertThrows(PluginInstallException.class, () -> installer(dir, "0.2.5").install(bad, SRC, null, "local"));
    }

    @Test
    void enforcesSha256(@TempDir Path dir) throws Exception {
        byte[] z = zip(flat("hello", null));
        String correct = PluginPackage.sha256(z);
        // 不一致は拒否。
        assertThrows(PluginInstallException.class,
                () -> installer(dir, "0.2.5").install(z, SRC, "deadbeef", "local"));
        // 一致は成功。
        InstalledPlugin rec = installer(dir, "0.2.5").install(z, SRC, correct, "local");
        assertEquals(correct, rec.sha256());
    }

    @Test
    void enforcesEnginesCompat(@TempDir Path dir) throws Exception {
        byte[] ok = zip(flat("hello", ">=0.2.0 <0.3.0"));
        byte[] tooNew = zip(flat("world", ">=0.3.0"));
        installer(dir, "0.2.5").install(ok, SRC, null, "local"); // 互換 → OK
        assertThrows(PluginInstallException.class,
                () -> installer(dir, "0.2.5").install(tooNew, SRC, null, "local")); // 非互換 → 拒否
    }

    @Test
    void rejectsZipSlip(@TempDir Path dir) throws Exception {
        Map<String, byte[]> m = new LinkedHashMap<>();
        m.put("plugin.json", manifest("evil", null).getBytes(StandardCharsets.UTF_8));
        m.put("../escape.txt", "pwn".getBytes(StandardCharsets.UTF_8));
        byte[] z = zip(m);
        assertThrows(PluginInstallException.class, () -> installer(dir, "0.2.5").install(z, SRC, null, "local"));
        assertFalse(Files.exists(dir.resolve("escape.txt")), "no escape write");
        assertFalse(Files.exists(dir.getParent().resolve("escape.txt")), "no parent escape write");
    }

    @Test
    void rejectsInvalidId(@TempDir Path dir) throws Exception {
        byte[] z = zip(flat("../bad", null));
        assertThrows(PluginInstallException.class, () -> installer(dir, "0.2.5").install(z, SRC, null, "local"));
    }

    @Test
    void enableDisableTogglesMarker(@TempDir Path dir) throws Exception {
        PluginInstaller inst = installer(dir, "0.2.5");
        inst.install(zip(flat("hello", null)), SRC, null, "local");
        Path marker = dir.resolve("hello/.disabled");

        inst.setEnabled("hello", false);
        assertTrue(Files.exists(marker), "disabled marker present");
        assertFalse(inst.installed().get(0).enabled(), "ledger reflects disabled");

        inst.setEnabled("hello", true);
        assertFalse(Files.exists(marker), "marker removed");
        assertTrue(inst.installed().get(0).enabled(), "ledger reflects enabled");
    }

    @Test
    void reinstallReplacesSameId(@TempDir Path dir) throws Exception {
        PluginInstaller inst = installer(dir, "0.2.5");
        inst.install(zip(flat("hello", null)), SRC, null, "local");
        // 同 id・別内容で再導入 → 置換され台帳は 1 件のまま。
        Map<String, byte[]> v2 = flat("hello", null);
        v2.put("extra.txt", "v2".getBytes(StandardCharsets.UTF_8));
        inst.install(zip(v2), SRC, null, "local");

        assertEquals(1, inst.installed().size());
        assertTrue(Files.isRegularFile(dir.resolve("hello/extra.txt")), "new content present");
    }

    @Test
    void uninstallRemovesFolderAndLedger(@TempDir Path dir) throws Exception {
        PluginInstaller inst = installer(dir, "0.2.5");
        inst.install(zip(flat("hello", null)), SRC, null, "local");

        assertTrue(inst.uninstall("hello").existed());
        assertFalse(Files.exists(dir.resolve("hello")), "folder removed");
        assertTrue(inst.installed().isEmpty(), "ledger cleared");
        assertFalse(inst.uninstall("hello").existed(), "second uninstall is no-op");
    }

    /**
     * 🔴 削除・更新の前にクラスローダの解放フックが呼ばれること。
     *
     * <p>Windows では開いたままの JAR を削除できず、これを怠ると「backend 面を一度でも呼んだ
     * プラグインだけ削除に失敗し、plugin.json と ui.js だけ消えて JAR と台帳が残る」という
     * 壊れ方をする（2026-08-24 に実機で発生）。ファイルロックの再現は OS 依存なので、
     * ここでは<b>順序（消す前に呼ぶ）</b>を固定する。
     */
    @Test
    void releasesClassLoaderBeforeTouchingFiles(@TempDir Path dir) throws Exception {
        List<String> calls = new java.util.ArrayList<>();
        List<Boolean> folderStillThere = new java.util.ArrayList<>();
        PluginInstaller inst = new PluginInstaller(dir, MAPPER, "0.2.5", id -> {
            calls.add(id);
            folderStillThere.add(Files.exists(dir.resolve(id).resolve("plugin.json")));
        });

        inst.install(zip(flat("hello", null)), SRC, null, "local");
        assertEquals(List.of("hello"), calls, "導入(置換)の前にも解放する");
        calls.clear();
        folderStillThere.clear();

        inst.uninstall("hello");
        assertEquals(List.of("hello"), calls, "削除の前に解放する");
        assertEquals(List.of(true), folderStillThere, "★消す前に呼ばれている（後だと手遅れ）");
    }

    /** 消せなかった残骸（.uninstall-pending）は次回起動時に消える。 */
    @Test
    void sweepsLeftoversOnStartup(@TempDir Path dir) throws Exception {
        Path leftover = dir.resolve("ghost");
        Files.createDirectories(leftover);
        Files.writeString(leftover.resolve("ghost.jar"), "x");
        Files.writeString(leftover.resolve(".uninstall-pending"), "pending");

        installer(dir, "0.2.5");   // 起動を模す

        assertFalse(Files.exists(leftover), "起動時に掃除される");
    }
}
