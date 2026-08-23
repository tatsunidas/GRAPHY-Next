/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import com.vis.graphynext.nondicom.FfmpegLocator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * XA シネを MP4 にする（{@code fw/angio-design.md} §14.3 / A10）。
 *
 * <h3>なぜフロントから画像を送るのか</h3>
 * 出したいのは<b>今見えている絵</b>——DSA の差分・ピクセルシフト・W/L・白黒反転を当てた後の
 * 画像で、これらは<b>フロント側にしか存在しない</b>（DSA は合成ローダ、W/L は表示状態）。
 * 元の DICOM から作り直すと「画面と違う動画」が出る。だからフロントが焼いた PNG 列を受け取り、
 * ここは<b>並べて H.264 にする</b>ことだけをする。
 *
 * <h3>🚨 焼き込み文字は消えない</h3>
 * 画素に焼き込まれた患者情報は PNG にも MP4 にも残る。UI は書き出し前に必ず確認を出す
 * （{@code xa.export.burnedInWarning}）。ここでは消せない。
 *
 * <h3>🔴 zip-slip を通さない</h3>
 * 受け取るのは外から来た ZIP。エントリ名をそのまま結合すると
 * {@code ../../} で任意の場所に書ける。名前は<b>使わず</b>、順序だけ使って採番し直す。
 */
@Service
public class AngioMp4Service {

    private static final Logger log = LoggerFactory.getLogger(AngioMp4Service.class);

    /** 1 回の書き出しで受け付ける最大フレーム数（XA の 1 ラン＝数百フレーム）。 */
    static final int MAX_FRAMES = 2000;
    /** ffmpeg の最長実行時間。 */
    private static final long TIMEOUT_MINUTES = 10;

    /** ffmpeg が見つからないとき。呼び出し側は 422 にする（500 ではない＝環境の問題）。 */
    public static class FfmpegUnavailableException extends IOException {
        public FfmpegUnavailableException(String message) {
            super(message);
        }
    }

    private final FfmpegLocator ffmpeg;

    public AngioMp4Service(FfmpegLocator ffmpeg) {
        this.ffmpeg = ffmpeg;
    }

    /**
     * PNG 列の ZIP を MP4 にする。
     *
     * @param zipBytes PNG を並べた ZIP（エントリ名の昇順がフレーム順）
     * @param fps      フレームレート
     * @return MP4 のバイト列
     */
    public byte[] encode(byte[] zipBytes, double fps) throws IOException {
        double rate = fps > 0 && fps <= 240 ? fps : 15;
        Path dir = Files.createTempDirectory("angio-mp4-");
        try {
            int frames = extractPngs(zipBytes, dir);
            if (frames == 0) {
                throw new IOException("PNG が 1 枚もありません");
            }
            String bin = ffmpeg.resolve();
            if (bin == null || bin.isBlank() || !new java.io.File(bin).exists() && !isOnPath(bin)) {
                throw new FfmpegUnavailableException("ffmpeg が見つかりません");
            }
            Path out = dir.resolve("out.mp4");
            List<String> cmd = encodeCommand(bin, dir.resolve("f-%05d.png").toString(), rate, out.toString());
            run(cmd);
            if (!Files.exists(out) || Files.size(out) == 0) {
                throw new IOException("MP4 を生成できませんでした");
            }
            log.info("angio mp4: frames={} fps={} bytes={}", frames, rate, Files.size(out));
            return Files.readAllBytes(out);
        } finally {
            deleteTree(dir);
        }
    }

    /**
     * ZIP から PNG を取り出し、{@code f-00001.png} … に採番し直す。
     *
     * <p>🔴 <b>エントリ名は使わない</b>（zip-slip 対策）。並べ替えにだけ使い、書き出す名前は
     * こちらが決める。ffmpeg の連番入力に合わせる意味もある（欠番があると読み止まる）。
     *
     * @return 取り出した枚数
     */
    static int extractPngs(byte[] zipBytes, Path dir) throws IOException {
        record Entry(String name, byte[] data) {
        }
        List<Entry> entries = new ArrayList<>();
        try (ZipInputStream zin = new ZipInputStream(new ByteArrayInputStream(zipBytes))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                if (e.isDirectory()) {
                    continue;
                }
                String name = e.getName();
                if (!name.toLowerCase(Locale.ROOT).endsWith(".png")) {
                    // PNG 以外は無視する（ZIP に説明ファイルが混ざっていても動くように）。
                    continue;
                }
                if (entries.size() >= MAX_FRAMES) {
                    throw new IOException("フレーム数が上限 " + MAX_FRAMES + " を超えています");
                }
                entries.add(new Entry(name, readAll(zin)));
            }
        }
        // 名前の昇順＝フレーム順（フロントは 0 埋めの連番で入れている）。
        entries.sort(Comparator.comparing(Entry::name));
        int i = 0;
        for (Entry e : entries) {
            Path p = dir.resolve(String.format(Locale.ROOT, "f-%05d.png", ++i));
            Files.write(p, e.data());
        }
        return i;
    }

    /**
     * ffmpeg のコマンド。
     *
     * <p>{@code -bf 0}（B-frame 無効）と {@code yuv420p} は取込側 {@code VideoConverter} と揃える
     * （設計 §14.3 の「変換系を再利用」）。
     * 🔴 <b>{@code scale} で偶数に丸める</b>: H.264 の yuv420p は幅・高さが偶数でないと
     * エンコードできない。XA の 512×512 では問題にならないが、切り出しや将来の
     * 非正方サイズで<b>突然失敗する</b>ので入れておく。
     */
    static List<String> encodeCommand(String ffmpeg, String inputPattern, double fps, String out) {
        return List.of(
                ffmpeg, "-y",
                "-framerate", trimNumber(fps),
                "-i", inputPattern,
                "-an",
                "-c:v", "libx264",
                "-profile:v", "high", "-level:v", "4.1",
                "-bf", "0",
                "-pix_fmt", "yuv420p",
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-movflags", "+faststart",
                out);
    }

    /** 15.0 → "15"、14.985 → "14.985"（ffmpeg は小数の framerate を受け付ける）。 */
    static String trimNumber(double v) {
        if (v == Math.rint(v)) {
            return String.valueOf((long) v);
        }
        return String.format(Locale.ROOT, "%.3f", v);
    }

    private void run(List<String> cmd) throws IOException {
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            String out;
            try (InputStream is = p.getInputStream()) {
                out = new String(is.readAllBytes());
            }
            if (!p.waitFor(TIMEOUT_MINUTES, TimeUnit.MINUTES)) {
                p.destroyForcibly();
                throw new IOException("ffmpeg timed out");
            }
            if (p.exitValue() != 0) {
                log.warn("ffmpeg failed ({}):\n{}", p.exitValue(), tail(out));
                throw new IOException("ffmpeg failed (exit " + p.exitValue() + ")");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("ffmpeg interrupted", e);
        }
    }

    private static boolean isOnPath(String bin) {
        // PATH 解決に任せた名前（"ffmpeg" / "ffmpeg.exe"）はここでは存在確認しない。
        return !bin.contains("/") && !bin.contains("\\");
    }

    private static byte[] readAll(InputStream in) throws IOException {
        return in.readAllBytes();
    }

    private static String tail(String s) {
        int max = 2000;
        return s.length() <= max ? s : s.substring(s.length() - max);
    }

    private static void deleteTree(Path dir) {
        try (var walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // 後始末の失敗はログに残す価値が薄い（temp なので OS が回収する）
                }
            });
        } catch (IOException e) {
            log.debug("temp の後始末に失敗: {}", dir, e);
        }
    }
}
