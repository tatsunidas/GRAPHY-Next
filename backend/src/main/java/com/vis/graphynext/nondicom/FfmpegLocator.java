/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nondicom;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.system.ApplicationHome;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 同梱 ffmpeg バイナリの解決（AVI / 非 H.264 MP4 のトランスコード用）。
 *
 * <p>解決順:
 * <ol>
 *   <li>設定 {@code nondicom.ffmpeg}（実行ファイルの明示パス）</li>
 *   <li>環境変数 {@code GRAPHY_FFMPEG}</li>
 *   <li>同梱探索: 設定 {@code nondicom.ffmpeg-dir} / 環境変数 {@code GRAPHY_FFMPEG_DIR} /
 *       <b>jar 隣接の {@code ffmpeg/}・{@code ../ffmpeg/}</b>（Electron では {@code resources/ffmpeg}）/
 *       カレントの {@code ffmpeg}・{@code resources/ffmpeg}・{@code desktop/resources/ffmpeg}。
 *       各ディレクトリで {@code <bin>}（フラット同梱）と {@code <os-arch>/<bin>}（ツリー同梱）を探す。</li>
 *   <li>見つからなければ PATH 上の {@code ffmpeg}（{@code ffmpeg.exe}）</li>
 * </ol>
 * 配置規約・自動取得は {@code scripts/fetch-ffmpeg.sh} と {@code fw/nondicom-ffmpeg.md} を参照。
 */
@Component
public class FfmpegLocator {

    private static final Logger log = LoggerFactory.getLogger(FfmpegLocator.class);

    private final String explicit;
    private final String bundleDir;
    private volatile String resolved;

    public FfmpegLocator(@Value("${nondicom.ffmpeg:}") String explicit,
                         @Value("${nondicom.ffmpeg-dir:}") String bundleDir) {
        this.explicit = explicit;
        this.bundleDir = bundleDir;
    }

    /** 解決した ffmpeg 実行パス（初回のみ探索しキャッシュ）。 */
    public String resolve() {
        String r = resolved;
        if (r == null) {
            synchronized (this) {
                r = resolved;
                if (r == null) {
                    r = doResolve();
                    resolved = r;
                    log.info("ffmpeg path resolved: {} (os-arch={})", r, osArch());
                }
            }
        }
        return r;
    }

    private String doResolve() {
        if (notBlank(explicit)) {
            return explicit; // 明示指定は尊重（存在検証は実行時の -version に委ねる）
        }
        String envBin = System.getenv("GRAPHY_FFMPEG");
        if (notBlank(envBin)) {
            return envBin;
        }
        String bin = binaryName();
        for (Path dir : candidateDirs()) {
            Path flat = dir.resolve(bin);
            if (Files.isRegularFile(flat)) {
                return flat.toString();
            }
            Path tree = dir.resolve(osArch()).resolve(bin);
            if (Files.isRegularFile(tree)) {
                return tree.toString();
            }
        }
        return "ffmpeg"; // PATH フォールバック
    }

    private List<Path> candidateDirs() {
        List<Path> dirs = new ArrayList<>();
        addDir(dirs, bundleDir);
        addDir(dirs, System.getenv("GRAPHY_FFMPEG_DIR"));
        Path jarDir = jarDir();
        if (jarDir != null) {
            dirs.add(jarDir.resolve("ffmpeg"));
            Path parent = jarDir.getParent();
            if (parent != null) {
                dirs.add(parent.resolve("ffmpeg")); // Electron: resources/backend → resources/ffmpeg
            }
        }
        Path cwd = Path.of("").toAbsolutePath();
        dirs.add(cwd.resolve("ffmpeg"));
        dirs.add(cwd.resolve("resources").resolve("ffmpeg"));               // desktop/ から起動
        dirs.add(cwd.resolve("desktop").resolve("resources").resolve("ffmpeg")); // repo ルートから起動
        return dirs;
    }

    private static void addDir(List<Path> dirs, String s) {
        if (notBlank(s)) {
            dirs.add(Path.of(s));
        }
    }

    /**
     * jar（このバックエンド jar）を含むディレクトリ。Spring Boot の実行可能 jar は
     * {@code BOOT-INF/} 配下を {@code nested:} スキームの仮想 FS として読むため、
     * {@code getProtectionDomain().getCodeSource()} から素朴に {@link Path#of} すると
     * その仮想 FS 内のパスになってしまい、実ファイルシステム上の同梱ディレクトリと一致しない。
     * {@link ApplicationHome} はこのケースを正しく解決する Spring Boot 提供のユーティリティ。
     */
    private static Path jarDir() {
        try {
            return new ApplicationHome(FfmpegLocator.class).getDir().toPath();
        } catch (Exception e) {
            return null;
        }
    }

    /** {@code win-x64 / mac-arm64 / linux-x64} 等。配置ディレクトリ名と一致させる。 */
    static String osArch() {
        String os = System.getProperty("os.name", "").toLowerCase();
        String arch = System.getProperty("os.arch", "").toLowerCase();
        String o = os.contains("win") ? "win"
                : (os.contains("mac") || os.contains("darwin")) ? "mac" : "linux";
        String a = (arch.contains("aarch64") || arch.contains("arm64")) ? "arm64" : "x64";
        return o + "-" + a;
    }

    static String binaryName() {
        return System.getProperty("os.name", "").toLowerCase().contains("win") ? "ffmpeg.exe" : "ffmpeg";
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
