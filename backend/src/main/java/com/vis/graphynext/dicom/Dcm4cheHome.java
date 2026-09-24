/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.springframework.boot.system.ApplicationHome;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 同梱 dcm4che 配布物（{@code bin/} と {@code lib/}）の置き場所を解決する。
 *
 * <p>🔴 <b>この探索規則の 2 つ目を書かないこと。</b> 使う側は 2 つある——
 * QR の CLI ツール（{@code bin/findscu} 等）を起動する {@code Dcm4cheTools} と、
 * 匿名化の焼き込みで圧縮画素を伸長するために {@code lib/<os-arch>/libopencv_java} を
 * 読み込む {@code PixelCodec}。同じ配布物の同じ置き場所なので、探索規則が 2 つに割れると
 * 「QR は動くのに伸長だけ効かない（あるいはその逆）」という切り分けの難しい状態になる。
 *
 * <p>配置規約と取得は {@code scripts/fetch-dcm4che-tools.sh} を参照。
 */
public final class Dcm4cheHome {

    private Dcm4cheHome() {
    }

    /**
     * 解決順: 明示設定（{@code graphy.dicom.dcm4che-home}）→ 同梱ディレクトリ探索
     * （jar 隣接の {@code dcm4che/}・{@code ../dcm4che/}（Electron では {@code resources/dcm4che}）／
     * カレントの {@code dcm4che}・{@code resources/dcm4che}・{@code desktop/resources/dcm4che}）→
     * {@code ~/dcm4che-*} 自動検出（開発機向け）。
     *
     * @param explicitHome {@code graphy.dicom.dcm4che-home}（空なら無視）
     */
    public static List<Path> candidateDirs(String explicitHome) {
        List<Path> bases = new ArrayList<>();
        if (explicitHome != null && !explicitHome.isBlank()) {
            bases.add(Path.of(explicitHome));
        }
        Path jarDir = jarDir();
        if (jarDir != null) {
            bases.add(jarDir.resolve("dcm4che"));
            Path parent = jarDir.getParent();
            if (parent != null) {
                bases.add(parent.resolve("dcm4che")); // Electron: resources/backend → resources/dcm4che
            }
        }
        Path cwd = Path.of("").toAbsolutePath();
        bases.add(cwd.resolve("dcm4che"));
        bases.add(cwd.resolve("resources").resolve("dcm4che"));               // desktop/ から起動
        bases.add(cwd.resolve("desktop").resolve("resources").resolve("dcm4che")); // repo ルートから起動
        // ~/dcm4che-* を自動検出（開発機の手動インストール向けフォールバック）
        Path userHome = Path.of(System.getProperty("user.home"));
        try (DirectoryStream<Path> s = Files.newDirectoryStream(userHome, "dcm4che-*")) {
            for (Path d : s) {
                bases.add(d);
            }
        } catch (IOException ignore) {
            // 検出不可
        }
        return bases;
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
            return new ApplicationHome(Dcm4cheHome.class).getDir().toPath();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * dcm4che 配布物の {@code lib/<os-arch>} に置かれるネイティブライブラリ名の部品。
     *
     * <p>ディレクトリ名は dcm4che / weasis の規約（{@code linux-x86-64}・{@code windows-x86-64}・
     * {@code macosx-aarch64} など）。{@code org.weasis.core.util.NativeLibrary} が同じ文字列を
     * 作るが、<b>それを呼ぶと OpenCV のクラス初期化に触れてしまう</b>ので、ここでは
     * {@code os.name}/{@code os.arch} から自前で組み立てる（ネイティブを読む前に
     * 「どこを読むか」を決める必要がある）。
     */
    public static String nativeLibDirName() {
        String os = System.getProperty("os.name", "").toLowerCase();
        String arch = System.getProperty("os.arch", "").toLowerCase();
        String osPart = os.startsWith("win") ? "windows" : os.startsWith("mac") ? "macosx" : "linux";
        String archPart = switch (arch) {
            case "amd64", "x86_64" -> "x86-64";
            case "aarch64", "arm64" -> "aarch64";
            case "x86", "i386", "i486", "i586", "i686" -> "x86";
            default -> arch;
        };
        return osPart + "-" + archPart;
    }

    /** そのプラットフォームでの OpenCV ネイティブのファイル名。 */
    public static String openCvLibFileName() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.startsWith("win")) {
            return "opencv_java.dll";
        }
        return os.startsWith("mac") ? "libopencv_java.dylib" : "libopencv_java.so";
    }
}
