package com.vis.uvs.plugin;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;

/**
 * 予測に要るフレームだけを<b>生 rgb24 のまま</b>ディスクに置く（{@code fw/uvs-plugin-design.md} 段 6）。
 *
 * <h3>なぜ生のまま置くのか</h3>
 * 🔴 <b>グレー値に落として保存してはいけない。</b> ROI 抽出は {@code Frame#grayFloat()}（丸め無し）を、
 * {@code RoiCropper} は {@code Frame#gray()}（四捨五入）を使う。8bit のグレーに畳んで保存すると
 * {@code grayFloat} が最大 0.5 ずれ、Farnebäck の入力が変わる——<b>段 4 の「移植元と完全一致」が
 * 静かに壊れる</b>。PNG 等に再圧縮するのも同じ理由で不可（ffmpeg の別フィルタ経路を通すと
 * 画素が一致する保証が無い）。<b>sink が見た byte[] をそのまま書く</b>なら、一致は構造上の帰結になる。
 *
 * <h3>容量</h3>
 * 720×536 で 1.16 MB/枚。interval 15・stride 6 なら 4,958 フレームで 331×2 ≒ 767 MB。
 * 🔴 <b>始める前に空きを確かめて、足りなければ即エラー</b>（黙ってディスクを埋めない）。
 */
public final class FrameCache {

    private final Path dir;
    private final int frameBytes;

    public FrameCache(Path dir, int width, int height) throws IOException {
        this.dir = dir.resolve("frames");
        this.frameBytes = width * height * 3;
        Files.createDirectories(this.dir);
    }

    /** 1 フレームのバイト数。容量の見積もりに使う。 */
    public int frameBytes() {
        return frameBytes;
    }

    private Path fileOf(int index) {
        return dir.resolve("f" + index + ".rgb");
    }

    public boolean has(int index) {
        return Files.isRegularFile(fileOf(index));
    }

    /**
     * 書く。⚠️ 呼び出し側の配列は使い回されるので、<b>ここで即座にディスクへ落とす</b>
     * （参照を保持しない）。
     */
    public void write(int index, byte[] frame) throws IOException {
        if (frame.length != frameBytes) {
            throw new IOException("フレームの大きさが違う: " + frame.length + " != " + frameBytes);
        }
        Files.write(fileOf(index), frame);
    }

    /** 読む。無ければ null（呼び出し側が「用意されていない」と言えるように例外にしない）。 */
    public byte[] read(int index) throws IOException {
        Path f = fileOf(index);
        if (!Files.isRegularFile(f)) return null;
        byte[] b = Files.readAllBytes(f);
        return b.length == frameBytes ? b : null;
    }

    /** 置いてあるフレーム数。 */
    public int count() throws IOException {
        try (var s = Files.list(dir)) {
            return (int) s.filter(Files::isRegularFile).count();
        }
    }

    /** 置いてある合計バイト数（画面に出す）。 */
    public long bytes() throws IOException {
        try (var s = Files.list(dir)) {
            long total = 0;
            for (Path p : s.toList()) {
                if (Files.isRegularFile(p)) total += Files.size(p);
            }
            return total;
        }
    }

    /**
     * キャッシュしたフレームの md5。
     *
     * <p>🔑 <b>「キャッシュしたものは、復号したものと同じか」を数字で言うため</b>にある。
     * ここが崩れていると ROI が静かにずれ、段 4 / 段 5 の一致が無音で壊れる——
     * <b>画面を作る前にここを潰す</b>のが段 6 の着手順の理由である。
     */
    public String digest(int index) throws Exception {
        byte[] b = read(index);
        return b == null ? null : md5(b);
    }

    /** 生バイト列の md5（16 進小文字）。 */
    public static String md5(byte[] b) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(b));
    }

    /** 置き場（画面やログに出す）。 */
    public Path dir() {
        return dir;
    }
}
