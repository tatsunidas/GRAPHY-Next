/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.plugin.PluginDescriptor;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * プラグイン配布 zip（{@code plugin.json} ＋任意 {@code ui.js} / {@code *.jar}）の
 * 検証・読取・展開ユーティリティ。JDK 標準のみ（{@code java.util.zip} / {@code MessageDigest}）。
 *
 * <p>zip 直下に {@code plugin.json} を置く構成を基本とするが、単一のラップフォルダ
 * （例 GitHub の source zip 風 {@code repo-1.2.3/plugin.json}）にも対応するため、
 * {@code plugin.json} を含む最短プレフィックスを基準ディレクトリとして扱う。
 *
 * <p><b>zip slip 対策</b>: 展開時に各エントリの正規化後パスが対象ディレクトリ配下に
 * 収まることを必ず検証する。
 */
final class PluginPackage {

    /** 展開許容の上限（zip 爆弾対策の粗いガード）。 */
    private static final long MAX_TOTAL_BYTES = 256L * 1024 * 1024;
    private static final int MAX_ENTRIES = 10_000;

    private PluginPackage() {}

    /** SHA-256 の小文字 hex。 */
    static String sha256(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(data);
            StringBuilder sb = new StringBuilder(h.length * 2);
            for (byte b : h) sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e); // 標準アルゴリズムなので通常発生しない
        }
    }

    /**
     * {@code plugin.json} を含む基準プレフィックスを返す（末尾に区切りを含む、直下なら空文字）。
     *
     * @throws PluginInstallException plugin.json が見つからない zip
     */
    static String manifestBasePrefix(byte[] zip) {
        String best = null;
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip))) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                String name = e.getName().replace('\\', '/');
                if (name.equals("plugin.json") || name.endsWith("/plugin.json")) {
                    // 最短（＝スラッシュが最少）のものを採用。
                    if (best == null || slashCount(name) < slashCount(best)) best = name;
                }
                in.closeEntry();
            }
        } catch (IOException ex) {
            throw new PluginInstallException("invalid zip: " + ex.getMessage());
        }
        if (best == null) throw new PluginInstallException("plugin.json not found in package");
        int idx = best.lastIndexOf("plugin.json");
        return best.substring(0, idx); // "" もしくは "repo-1.2.3/"
    }

    /** 基準プレフィックス配下の {@code plugin.json} を {@link PluginDescriptor} として読む。 */
    static PluginDescriptor readDescriptor(byte[] zip, String base, ObjectMapper mapper) {
        String manifestName = base + "plugin.json";
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip))) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                if (e.getName().replace('\\', '/').equals(manifestName)) {
                    byte[] bytes = in.readAllBytes();
                    PluginDescriptor d = mapper.readValue(bytes, PluginDescriptor.class);
                    if (d == null || d.id() == null || d.id().isBlank()) {
                        throw new PluginInstallException("plugin.json missing id");
                    }
                    return d;
                }
                in.closeEntry();
            }
        } catch (IOException ex) {
            throw new PluginInstallException("failed to read plugin.json: " + ex.getMessage());
        }
        throw new PluginInstallException("plugin.json not found in package");
    }

    /**
     * 基準プレフィックス配下を {@code targetDir} に展開する（プレフィックスは除去）。
     * zip slip・サイズ超過を検証する。
     */
    static void extract(byte[] zip, String base, Path targetDir) throws IOException {
        Path root = targetDir.toAbsolutePath().normalize();
        Files.createDirectories(root);
        long total = 0;
        int count = 0;
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip))) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                String name = e.getName().replace('\\', '/');
                if (!name.startsWith(base)) { in.closeEntry(); continue; }
                String rel = name.substring(base.length());
                if (rel.isEmpty()) { in.closeEntry(); continue; }
                if (e.isDirectory()) { in.closeEntry(); continue; }
                if (++count > MAX_ENTRIES) throw new PluginInstallException("too many entries in package");
                Path out = root.resolve(rel).normalize();
                if (!out.startsWith(root)) {
                    throw new PluginInstallException("zip slip detected: " + name);
                }
                Files.createDirectories(out.getParent());
                byte[] data = in.readAllBytes();
                total += data.length;
                if (total > MAX_TOTAL_BYTES) throw new PluginInstallException("package too large");
                Files.write(out, data);
                in.closeEntry();
            }
        }
    }

    private static int slashCount(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) == '/') n++;
        return n;
    }
}
