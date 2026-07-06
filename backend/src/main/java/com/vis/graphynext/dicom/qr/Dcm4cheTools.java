/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.system.ApplicationHome;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * dcm4che の CLI ツール（getscu / movescu / findscu / storescu）をプロセス起動するヘルパ。
 *
 * <p>standalone の C-GET/C-MOVE は自前で DIMSE クライアントを実装せず、実績ある dcm4che
 * ツールを起動して解決する。ツールの場所の解決順は {@link #candidateDirs()} を参照
 * （明示設定 → 同梱ディレクトリ → {@code ~/dcm4che-*} 自動検出）。配置規約・取得は
 * {@code scripts/fetch-dcm4che-tools.sh} を参照。
 *
 * <p>ツール本体は Java 製（{@code bin/findscu} 等は同梱 jar を起動するだけのラッパー）なので、
 * JRE 同梱は不要——{@link #run} で現在実行中の JVM の {@code java.home} を {@code JAVA_HOME}
 * として明示注入し、実行環境にシステム Java が無くても解決できるようにする。
 */
@Component
public class Dcm4cheTools {

    private static final Logger log = LoggerFactory.getLogger(Dcm4cheTools.class);

    private final DicomProperties props;

    public Dcm4cheTools(DicomProperties props) {
        this.props = props;
    }

    public record Result(int exitCode, String output) {
        public boolean ok() {
            return exitCode == 0;
        }
    }

    /** 指定ツールの実行ファイルを解決する（Windows は .bat も考慮）。 */
    public Optional<Path> tool(String name) {
        boolean win = System.getProperty("os.name", "").toLowerCase().contains("win");
        for (Path base : candidateDirs()) {
            for (String exe : win ? new String[]{name + ".bat", name + ".exe", name} : new String[]{name}) {
                Path p = base.resolve("bin").resolve(exe);
                if (Files.isExecutable(p)) {
                    return Optional.of(p);
                }
            }
        }
        return Optional.empty();
    }

    /**
     * 解決順: 明示設定（{@code graphy.dicom.dcm4che-home}）→ 同梱ディレクトリ探索
     * （jar 隣接の {@code dcm4che/}・{@code ../dcm4che/}（Electron では {@code resources/dcm4che}）／
     * カレントの {@code dcm4che}・{@code resources/dcm4che}・{@code desktop/resources/dcm4che}）→
     * {@code ~/dcm4che-*} 自動検出（開発機向け）。
     */
    private List<Path> candidateDirs() {
        List<Path> bases = new ArrayList<>();
        String home = props.getDcm4cheHome();
        if (home != null && !home.isBlank()) {
            bases.add(Path.of(home));
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
            return new ApplicationHome(Dcm4cheTools.class).getDir().toPath();
        } catch (Exception e) {
            return null;
        }
    }

    public boolean isAvailable(String name) {
        return tool(name).isPresent();
    }

    public Path require(String name) {
        return tool(name).orElseThrow(() -> new IllegalStateException(
                "dcm4che ツール '" + name + "' が見つかりません。同梱の resources/dcm4che が壊れているか、"
                        + "開発機なら graphy.dicom.dcm4che-home を設定するか ~/dcm4che-* を配置してください。"));
    }

    /** コマンドを実行し、標準出力/標準エラーを結合して返す。timeout 超過は例外。 */
    public Result run(List<String> command, long timeoutMs) throws IOException {
        log.debug("exec: {}", String.join(" ", command)); // 外部ツール起動: トラブル時に DEBUG で確認
        ProcessBuilder pb = new ProcessBuilder(command).redirectErrorStream(true);
        // ツール本体は同梱 jar を起動する Java 製ラッパー。実行環境にシステム Java が無くても
        // 動くよう、今このバックエンドを動かしている JVM 自身の home を JAVA_HOME として渡す。
        pb.environment().put("JAVA_HOME", System.getProperty("java.home"));
        // bin/<tool>[.bat] は DCM4CHE_HOME が環境に既に設定されているとそれを優先してしまい、
        // 同梱ディレクトリと異なる（バージョン不整合・存在しない可能性がある）場所を見てしまう。
        // 実際に解決・起動する tool() の場所から常に明示上書きし、同梱物だけを使わせる。
        Path toolDir = Path.of(command.get(0)).toAbsolutePath().getParent();
        if (toolDir != null && toolDir.getParent() != null) {
            pb.environment().put("DCM4CHE_HOME", toolDir.getParent().toString());
        }
        Process p = pb.start();
        StringBuilder out = new StringBuilder();
        // 暴走ツール対策: 取り込みは上限まで。超過分はドレインのみ（ブロック回避）し蓄積しない。
        final int maxChars = 64 * 1024;
        try (var r = p.inputReader()) {
            char[] buf = new char[4096];
            int n;
            while ((n = r.read(buf)) != -1) {
                if (out.length() < maxChars) {
                    out.append(buf, 0, Math.min(n, maxChars - out.length()));
                }
            }
            if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                p.destroyForcibly();
                throw new IOException("ツール実行がタイムアウト: " + String.join(" ", command));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("ツール実行が中断されました", e);
        }
        return new Result(p.exitValue(), out.toString());
    }
}
