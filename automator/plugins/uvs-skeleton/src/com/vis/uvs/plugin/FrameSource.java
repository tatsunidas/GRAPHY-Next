package com.vis.uvs.plugin;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.function.BiConsumer;

/**
 * `/rendered` の MP4 を ffmpeg で rgb24 のフレーム列に開く（{@code fw/uvs-plugin-design.md} §3.2）。
 *
 * <h3>なぜ本体の DICOM を自分で解かないのか</h3>
 * GRAPHY-Next は encapsulated PixelData から MP4 を取り出す口を**既に持っている**
 * （`/api/instances/{sop}/rendered`）。段 1 で実測した `transcodeRequired: false` のとおり、
 * 取り込んだ H.264 は**そのまま**取り出せる。**同じことを 2 度書かない。**
 *
 * <h3>🔴 全フレームをメモリに載せない</h3>
 * 720×440×3 = 950KB/フレーム。数千フレームで数 GB になる。
 * ffmpeg の標準出力を**流しながら 1 枚ずつ**渡す（`forEachPair` は 2 枚だけ保持する）。
 *
 * <h3>⚠️ 表示順で出てくる</h3>
 * `-f rawvideo` の出力は presentation order。B フレームがあっても並べ替えは ffmpeg がやる。
 */
public final class FrameSource {

    private final Path mp4;
    private final String ffmpeg;
    /** この MP4 を close() で消してよいか。セッションから借りた MP4 は消さない。 */
    private final boolean ownsMp4;
    public final int width;
    public final int height;

    private FrameSource(Path mp4, String ffmpeg, int width, int height, boolean ownsMp4) {
        this.mp4 = mp4;
        this.ffmpeg = ffmpeg;
        this.width = width;
        this.height = height;
        this.ownsMp4 = ownsMp4;
    }

    /** `/rendered` から MP4 を落として開く。 */
    public static FrameSource fromRendered(String apiBase, String sop, String ffmpeg,
                                           int width, int height) throws Exception {
        Path tmp = Files.createTempFile("uvs-", ".mp4");
        String url = apiBase + "/api/instances/" + sop + "/rendered";
        try (HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            HttpResponse<Path> res = http.send(
                    HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMinutes(10)).GET().build(),
                    HttpResponse.BodyHandlers.ofFile(tmp));
            if (res.statusCode() / 100 != 2) {
                throw new IOException("/rendered が " + res.statusCode() + " を返しました: " + url);
            }
        }
        return new FrameSource(tmp, ffmpeg, width, height, true);
    }

    /**
     * 既に手元にある MP4 を開く（{@link UvsSession} が 1 回だけ落としたもの）。
     * 🔑 <b>この経路は MP4 を消さない。</b> セッションが持ち主である。
     */
    public static FrameSource fromFile(Path mp4, String ffmpeg, int width, int height) {
        return new FrameSource(mp4, ffmpeg, width, height, false);
    }

    public void close() {
        if (!ownsMp4) return;
        try {
            Files.deleteIfExists(mp4);
        } catch (IOException ignored) {
            /* 一時ファイルなので放置してよい */
        }
    }

    /**
     * 隣り合う 2 フレームを順に渡す（`i`, `i+1`）。最後のフレームは相手が無いので呼ばれない。
     *
     * <p>🔑 色判定は 1 枚、静止判定は 2 枚が要る。**動画を 2 回開かない**ように
     * ここで両方を賄う（1 パスで済む）。
     *
     * @param limit 先頭から何フレームまで見るか（0 以下なら全部）
     * @param sink  (index, [cur, next]) を受け取る。index は 0 origin
     */
    public int forEachPair(int limit, BiConsumer<Integer, byte[][]> sink) throws Exception {
        int frameBytes = width * height * 3;
        ProcessBuilder pb = new ProcessBuilder(
                ffmpeg, "-v", "error", "-i", mp4.toString(),
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-");
        pb.redirectErrorStream(false);
        Process proc = pb.start();
        int seen = 0;
        try (DataInputStream in = new DataInputStream(proc.getInputStream())) {
            byte[] cur = new byte[frameBytes];
            byte[] next = new byte[frameBytes];
            if (!readFully(in, cur)) return 0;
            seen = 1;
            while (limit <= 0 || seen < limit) {
                if (!readFully(in, next)) break;
                sink.accept(seen - 1, new byte[][]{cur, next});
                byte[] swap = cur;
                cur = next;
                next = swap;
                seen++;
            }
        } finally {
            // 🔴 **読み切る前に止めるので、必ず破棄する。** 放置すると ffmpeg が
            //    パイプの書き込みでブロックしたまま残る。
            proc.destroy();
            drainQuietly(proc.getErrorStream());
            proc.waitFor();
        }
        return seen;
    }

    /** {@link #forEachFrame} の受け手。渡される配列は<b>使い回される</b>ので、残すなら複製すること。 */
    @FunctionalInterface
    public interface FrameConsumer {
        void accept(int index, byte[] frame) throws Exception;
    }

    /**
     * 先頭から {@code untilInclusive} 番目まで（0 origin）を <b>1 パス</b>で流す。
     *
     * <p>🔴 <b>`-ss` で途中から始めない。</b> 区間解析でも先頭から復号する。シークは
     * キーフレーム境界に丸められ、<b>フレーム番号が静かにずれる</b>——段 4 / 段 5 の
     * 「移植元と完全一致」は<b>番号が合っていること</b>に全面的に依存している。
     * 復号のやり直しより、ずれた ROI のほうがずっと高くつく。
     *
     * <p>⚠️ <b>渡す配列は使い回す。</b> 数千フレーム × 1.16MB を貯めない
     * （キャッシュへ書くのは呼び出し側が「必要な番号だけ」選ぶ）。
     *
     * @return 実際に読めたフレーム数
     */
    public int forEachFrame(int untilInclusive, FrameConsumer sink) throws Exception {
        int frameBytes = width * height * 3;
        ProcessBuilder pb = new ProcessBuilder(
                ffmpeg, "-v", "error", "-i", mp4.toString(),
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-");
        pb.redirectErrorStream(false);
        Process proc = pb.start();
        int seen = 0;
        try (DataInputStream in = new DataInputStream(proc.getInputStream())) {
            byte[] buf = new byte[frameBytes];
            while (untilInclusive < 0 || seen <= untilInclusive) {
                if (!readFully(in, buf)) break;
                sink.accept(seen, buf);
                seen++;
            }
        } finally {
            // 🔴 読み切る前に止めるので、必ず破棄する（放置すると ffmpeg がパイプで詰まって残る）。
            proc.destroy();
            drainQuietly(proc.getErrorStream());
            proc.waitFor();
        }
        return seen;
    }

    /**
     * a 番目と b 番目（0 origin）を **1 パス**で取る。範囲外は null。
     *
     * <p>🔴 <b>1 枚ごとに ffmpeg を起動しない。</b> 参照ドライバでそれをやって
     * **取りこぼした子プロセスで JVM が終わらなくなった**（10 分待って気づいた・2026-09-03）。
     * 起動を 1 回に減らし、`-frames:v` で必要な範囲だけ復号し、必ず強制終了する。
     */
    public byte[][] readPair(int a, int b) throws Exception {
        int frameBytes = width * height * 3;
        int last = Math.max(a, b);
        ProcessBuilder pb = new ProcessBuilder(
                ffmpeg, "-v", "error", "-i", mp4.toString(),
                "-frames:v", String.valueOf(last + 1),
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-");
        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
        Process proc = pb.start();
        byte[] fa = null;
        byte[] fb = null;
        try (DataInputStream in = new DataInputStream(proc.getInputStream())) {
            byte[] buf = new byte[frameBytes];
            for (int i = 0; i <= last; i++) {
                if (!readFully(in, buf)) break;
                if (i == a) fa = buf.clone();
                if (i == b) fb = buf.clone();
            }
        } finally {
            proc.destroyForcibly();
            proc.waitFor();
        }
        return new byte[][]{fa, fb};
    }

    private static boolean readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) return false; // 末尾（半端なフレームは捨てる）
            off += n;
        }
        return true;
    }

    private static void drainQuietly(InputStream in) {
        try (InputStream s = in; OutputStream sink = OutputStream.nullOutputStream()) {
            s.transferTo(sink);
        } catch (IOException ignored) {
            /* 破棄時のエラーは握る */
        }
    }
}
