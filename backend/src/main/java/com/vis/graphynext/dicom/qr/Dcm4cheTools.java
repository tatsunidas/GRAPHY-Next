/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.Dcm4cheHome;
import com.vis.graphynext.dicom.DicomProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
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
 * ツールを起動して解決する。ツールの場所の解決順は {@link Dcm4cheHome#candidateDirs(String)} を参照
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

    /**
     * ツールの実行結果。{@code timedOut} のとき、ツールは強制終了されており（終了コードは -1）、
     * {@code output} は<b>それまでに出た出力</b>（先頭と末尾）。受け取れていた応答の status を、呼び出し側が読める。
     */
    public record Result(int exitCode, String output, boolean timedOut) {
        public Result(int exitCode, String output) {
            this(exitCode, output, false);
        }

        /** 時間切れでなく、終了コードが 0。 */
        public boolean ok() {
            return !timedOut && exitCode == 0;
        }
    }

    /** 出力の保持: 先頭（A-ASSOCIATE のダンプ）と末尾（失敗の直前の状態遷移・例外・最終の status）を残す。 */
    static final int HEAD_CHARS = 32 * 1024;
    static final int TAIL_CHARS = 32 * 1024;

    /** 先頭 {@link #HEAD_CHARS} 文字と、末尾 {@link #TAIL_CHARS} 文字だけを持つ出力バッファ。間は省略の目印。 */
    static final class BoundedOutput {
        private final StringBuilder head = new StringBuilder();
        private final char[] ring;
        private long tailWritten;

        BoundedOutput(int tailChars) {
            this.ring = new char[tailChars];
        }

        synchronized void append(char[] buf, int off, int len) {
            for (int i = off; i < off + len; i++) {
                if (head.length() < HEAD_CHARS) {
                    head.append(buf[i]);
                } else {
                    ring[(int) (tailWritten++ % ring.length)] = buf[i];
                }
            }
        }

        @Override
        public synchronized String toString() {
            if (tailWritten == 0) {
                return head.toString();
            }
            StringBuilder sb = new StringBuilder(head);
            long dropped = Math.max(0, tailWritten - ring.length);
            if (dropped > 0) {
                sb.append("\n…（省略 ").append(dropped).append(" 文字）…\n");
            }
            int n = (int) Math.min(tailWritten, ring.length);
            int start = tailWritten > ring.length ? (int) (tailWritten % ring.length) : 0;
            for (int i = 0; i < n; i++) {
                sb.append(ring[(start + i) % ring.length]);
            }
            return sb.toString();
        }
    }

    /** 指定ツールの実行ファイルを解決する（Windows は .bat も考慮）。 */
    public Optional<Path> tool(String name) {
        boolean win = isWindows();
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

    /** @see Dcm4cheHome#candidateDirs(String) （探索規則の正本。ここでは持たない） */
    private List<Path> candidateDirs() {
        return Dcm4cheHome.candidateDirs(props.getDcm4cheHome());
    }

    public boolean isAvailable(String name) {
        return tool(name).isPresent();
    }

    public Path require(String name) {
        return tool(name).orElseThrow(() -> new IllegalStateException(
                "dcm4che ツール '" + name + "' が見つかりません。同梱の resources/dcm4che が壊れているか、"
                        + "開発機なら graphy.dicom.dcm4che-home を設定するか ~/dcm4che-* を配置してください。"));
    }

    /**
     * コマンドを実行し、標準出力/標準エラーを結合して返す。
     *
     * <p>🔴 出力は<b>別のスレッドで読む</b>。出力を EOF（＝プロセスの終了）まで読み切ってから待つ作りだと、止まったツール
     * （例: 解放 A-RELEASE に応答しない相手を待ち続ける findscu）は出力を閉じないので、読み取りで永久に止まり、
     * 時間切れの判定に到達しない。時間切れなら、<b>子孫のプロセスごと</b>強制終了する（Windows の {@code .bat} は
     * cmd.exe → java の入れ子）。時間切れでも例外にせず、それまでの出力を {@link Result#timedOut} 付きで返す
     * （受け取れていた応答の status を、呼び出し側が生かせる）。
     */
    public Result run(List<String> command, long timeoutMs) throws IOException {
        List<String> command2 = quoteForWindowsBatchIfNeeded(command);
        log.debug("exec: {}", String.join(" ", command2)); // 外部ツール起動: トラブル時に DEBUG で確認
        ProcessBuilder pb = new ProcessBuilder(command2).redirectErrorStream(true);
        // ツール本体は同梱 jar を起動する Java 製ラッパー。実行環境にシステム Java が無くても
        // 動くよう、今このバックエンドを動かしている JVM 自身の home を JAVA_HOME として明示注入する。
        pb.environment().put("JAVA_HOME", System.getProperty("java.home"));
        // bin/<tool>[.bat] は DCM4CHE_HOME が環境に既に設定されているとそれを優先してしまい、
        // 同梱ディレクトリと異なる（バージョン不整合・存在しない可能性がある）場所を見てしまう。
        // 実際に解決・起動する tool() の場所から常に明示上書きし、同梱物だけを使わせる。
        Path toolDir = Path.of(command.get(0)).toAbsolutePath().getParent();
        if (toolDir != null && toolDir.getParent() != null) {
            pb.environment().put("DCM4CHE_HOME", toolDir.getParent().toString());
        }
        Process p = pb.start();
        // 暴走ツール対策: 取り込みは先頭と末尾の上限まで。超過した中間はドレインのみ（ブロック回避）し蓄積しない。
        BoundedOutput out = new BoundedOutput(TAIL_CHARS);
        Thread reader = new Thread(() -> {
            try (var r = p.inputReader()) {
                char[] buf = new char[4096];
                int n;
                while ((n = r.read(buf)) != -1) {
                    out.append(buf, 0, n);
                }
            } catch (IOException ignore) {
                // プロセスの強制終了でストリームが閉じる。それまでの出力は残る
            }
        }, "dcm4che-tool-out");
        reader.setDaemon(true);
        reader.start();
        boolean done;
        try {
            done = p.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
            if (!done) {
                killTree(p);
            }
            reader.join(done ? 5_000 : 3_000);
        } catch (InterruptedException e) {
            killTree(p);
            Thread.currentThread().interrupt();
            throw new IOException("ツール実行が中断されました", e);
        }
        return new Result(done ? p.exitValue() : -1, out.toString(), !done);
    }

    /** プロセスと、その子孫（Windows の .bat が起こす java など）を強制終了する。 */
    private static void killTree(Process p) {
        p.descendants().forEach(ProcessHandle::destroyForcibly);
        p.destroyForcibly();
        try {
            p.waitFor(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Windows の同梱 {@code .bat} ランチャーは {@code %1}/{@code shift} で引数を読むが、この
     * cmd.exe のバッチパラメータ参照は引数中の {@code =} {@code ,} {@code ;} を（空白と同様に）
     * 区切り文字として再分割してしまう（cmd.exe の既知の挙動）。そのため、例えば
     * {@code -m StudyInstanceUID=1.2.3} は 1 引数のつもりでも movescu 側では
     * "StudyInstanceUID" と "1.2.3" の 2 引数に分かれてしまい、CLIUtils が値側を
     * タグ名として解釈しようとして {@code IllegalArgumentException} で落ちる
     * （findscu は無絞り込みだと "=" を含む引数が無く症状が出ないため気付きにくい）。
     * 該当文字を含む引数をダブルクォートで囲むと、cmd.exe のバッチパラメータ参照は
     * クォート区間を 1 トークンとして扱うため分割されず、java プロセスにはクォート無しの
     * 元の文字列がそのまま渡る（Windows のみ・{@code .bat} 起動時のみ適用。非 Windows や
     * 直接実行ファイルには無関係の挙動のため適用しない）。
     */
    private static List<String> quoteForWindowsBatchIfNeeded(List<String> command) {
        if (command.isEmpty() || !isWindows() || !command.get(0).toLowerCase().endsWith(".bat")) {
            return command;
        }
        List<String> out = new ArrayList<>(command.size());
        out.add(command.get(0));
        for (int i = 1; i < command.size(); i++) {
            String a = command.get(i);
            boolean needsQuote = a.indexOf('=') >= 0 || a.indexOf(',') >= 0 || a.indexOf(';') >= 0;
            out.add(needsQuote ? "\"" + a + "\"" : a);
        }
        return out;
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }
}
