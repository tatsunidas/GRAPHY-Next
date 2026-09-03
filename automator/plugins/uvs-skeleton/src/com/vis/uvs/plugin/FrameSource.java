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
    public final int width;
    public final int height;

    private FrameSource(Path mp4, String ffmpeg, int width, int height) {
        this.mp4 = mp4;
        this.ffmpeg = ffmpeg;
        this.width = width;
        this.height = height;
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
        return new FrameSource(tmp, ffmpeg, width, height);
    }

    public void close() {
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
