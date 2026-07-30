/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.video;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.nondicom.FfmpegLocator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * encapsulated video を <b>ブラウザ再生可能な MP4</b> に整えてキャッシュする（P4）。
 *
 * <p>判定は<b>転送構文ではなくペイロードの中身</b>で行う。理由: 我々の取込経路
 * （{@link com.vis.graphynext.nondicom.VideoConverter}）は MP4 を丸ごと 1 フラグメントに入れるが、
 * <b>モダリティ由来の正規 DICOM video は「コンテナ無しの基本ストリーム」</b>を入れてくる
 * （MPEG2 は MPEG-2 video ES、MPEG-4 AVC は H.264 Annex-B）。転送構文だけで「H.264 だから無変換で出せる」と
 * 判断すると、後者を `<video>` に渡して**再生できない**（P1 から残っていた穴）。
 *
 * <p>3 経路:
 * <ol>
 *   <li><b>そのまま配信</b> … ペイロードが MP4（{@code ftyp} ボックス）。ffmpeg 不要（主経路）。</li>
 *   <li><b>再多重化（remux）</b> … H.264/HEVC の基本ストリーム。{@code -c:v copy} で MP4 に包むだけ＝再圧縮なし。</li>
 *   <li><b>再エンコード</b> … MPEG2 等ブラウザ非対応。{@code libx264} で H.264 MP4 にする。</li>
 * </ol>
 * 2/3 は ffmpeg（{@link FfmpegLocator}）が要る。無ければ {@link TranscodeUnavailableException} を投げ、
 * 呼び側（{@code /rendered}）が 415 を返して UI が案内を出す。
 *
 * <p>キャッシュは {@code <storageDir>/.cache/video/{sop}.mp4}。同じ SOP への同時要求は SOP 単位のロックで
 * 直列化し、ffmpeg を二重に走らせない。書き込みは一時ファイル → 原子的 move なので、途中の壊れた MP4 を
 * 配信することはない。
 */
@Service
public class VideoRenderService {

    private static final Logger log = LoggerFactory.getLogger(VideoRenderService.class);

    /** 変換のタイムアウト（動画長に比例するが、配信経路なので取込側の 10 分より短くする）。 */
    private static final long FFMPEG_TIMEOUT_SEC = 300;

    /**
     * キャッシュの版。**変換コマンドを変えたら上げる**（古い成果物を配信し続けないため）。
     * v2 = 基本ストリームに {@code -r <fps>} を渡すようになった版（それ以前はフレームが 1 つずれていた）。
     */
    private static final String CACHE_VERSION = "v2";

    /** 基本ストリームの種類（ffmpeg への渡し方が変わる）。 */
    enum Payload {
        /** MP4 コンテナ。無変換で配信できる。 */
        MP4,
        /** H.264 Annex-B の基本ストリーム。remux（再圧縮なし）で MP4 にできる。 */
        H264_ES,
        /** HEVC Annex-B の基本ストリーム。remux で MP4 にできる。 */
        HEVC_ES,
        /** MPEG-2 video の基本ストリーム。ブラウザ非対応なので H.264 へ再エンコードする。 */
        MPEG2_ES,
        /** 判別できない。ffmpeg に probe させて再エンコードを試みる。 */
        UNKNOWN,
    }

    /** ffmpeg が要るのに使えない。呼び側は 415 を返す。 */
    public static class TranscodeUnavailableException extends IOException {
        public TranscodeUnavailableException(String message) {
            super(message);
        }
    }

    private final FfmpegLocator ffmpegLocator;
    private final Path cacheDir;
    private final Map<String, Object> locks = new ConcurrentHashMap<>();

    public VideoRenderService(FfmpegLocator ffmpegLocator, DicomProperties props) {
        this.ffmpegLocator = ffmpegLocator;
        this.cacheDir = Paths.get(props.getStorageDir(), ".cache", "video");
    }

    /**
     * 配信用 MP4 を用意して返す（あればキャッシュをそのまま使う）。
     *
     * @param dcm    DICOM ファイル
     * @param sopUid SOPInstanceUID（キャッシュのキー）
     * @throws TranscodeUnavailableException ffmpeg が要るのに使えない
     * @throws IOException                   抽出/変換の失敗
     */
    public Path ensureRendered(Path dcm, String sopUid) throws IOException {
        Path mp4 = cacheDir.resolve(cacheName(sopUid) + "." + CACHE_VERSION + ".mp4");
        if (isUsable(mp4, dcm)) {
            return mp4;
        }
        // SOP 単位で直列化（同じ動画を複数タブで開くと同時要求になり、ffmpeg が二重に走る）。
        Object lock = locks.computeIfAbsent(sopUid, k -> new Object());
        synchronized (lock) {
            if (isUsable(mp4, dcm)) {
                return mp4;
            }
            Files.createDirectories(cacheDir);
            Path raw = Files.createTempFile(cacheDir, "raw-", ".bin");
            try {
                VideoFragmentExtractor.extractTo(dcm, raw);
                Payload kind = sniff(raw);
                if (kind == Payload.MP4) {
                    // 主経路: 取込済み動画は MP4 そのもの。move するだけ（ffmpeg 不要）。
                    move(raw, mp4);
                    log.debug("rendered: MP4 をそのまま配信 sop={}", sopUid);
                    return mp4;
                }
                String ffmpeg = ffmpegLocator.resolve();
                if (!ffmpegAvailable(ffmpeg)) {
                    throw new TranscodeUnavailableException(
                            "ffmpeg が無いため " + kind + " を MP4 に変換できません (sop=" + sopUid + ")");
                }
                // 基本ストリームには時間情報が無いので、DICOM 側の fps を ffmpeg に教える（下記 buildCommand 参照）。
                double fps = VideoFragmentExtractor.readMeta(dcm).fps();
                Path out = Files.createTempFile(cacheDir, "conv-", ".mp4");
                try {
                    runFfmpeg(buildCommand(ffmpeg, kind, raw, out, fps), sopUid, kind);
                    if (!Files.exists(out) || Files.size(out) == 0) {
                        throw new IOException("ffmpeg produced no output (sop=" + sopUid + ")");
                    }
                    move(out, mp4);
                } finally {
                    Files.deleteIfExists(out);
                }
                log.info("rendered: {} を MP4 に変換しキャッシュしました sop={}", kind, sopUid);
                return mp4;
            } finally {
                Files.deleteIfExists(raw);
                locks.remove(sopUid, lock);
            }
        }
    }

    /** ffmpeg が使えるか（UI に「変換できる/できない」を伝えるため。結果は毎回問い合わせず十分速い）。 */
    public boolean transcodeAvailable() {
        return ffmpegAvailable(ffmpegLocator.resolve());
    }

    /**
     * キャッシュをそのまま使えるか。
     *
     * <p>存在とサイズだけでなく <b>元の DICOM より新しいこと</b>を要求する。同じ SOPInstanceUID を
     * 削除 → 再取込した場合（automator の reset も実ファイルは消すがこのキャッシュは消さない）に
     * <b>古い変換結果を配信し続けてしまう</b>ため。版が変わった時は {@link #CACHE_VERSION} を含む
     * ファイル名自体が変わるので、こちらは触らなくてよい。
     */
    private static boolean isUsable(Path mp4, Path dcm) throws IOException {
        if (!Files.exists(mp4) || Files.size(mp4) == 0) {
            return false;
        }
        try {
            return !Files.getLastModifiedTime(mp4).toInstant().isBefore(Files.getLastModifiedTime(dcm).toInstant());
        } catch (IOException e) {
            return false; // 元ファイルが読めない等は作り直す側に倒す
        }
    }

    private static void move(Path from, Path to) throws IOException {
        try {
            Files.move(from, to, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException atomicFailed) {
            // 原子的 move 非対応の FS（一部 Windows 構成）→ 通常 move。
            Files.move(from, to, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /**
     * ペイロード先頭を見て種類を判定する。
     *
     * <ul>
     *   <li>MP4 … 4 バイト目から {@code ftyp}（ISO BMFF のボックス型）</li>
     *   <li>MPEG-2 video ES … シーケンスヘッダ {@code 00 00 01 B3}（または GOP/picture start code）</li>
     *   <li>H.264 / HEVC Annex-B … start code {@code 00 00 01} / {@code 00 00 00 01} に続く NAL ヘッダで判別。
     *       H.264 は下位 5 bit の nal_unit_type（7=SPS）、HEVC は 2 バイト目の上位 6 bit（33=SPS）。</li>
     * </ul>
     */
    static Payload sniff(Path file) throws IOException {
        byte[] head = new byte[64];
        int n;
        try (InputStream in = Files.newInputStream(file)) {
            n = in.readNBytes(head, 0, head.length);
        }
        if (n >= 8 && head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p') {
            return Payload.MP4;
        }
        for (int i = 0; i + 4 < n; i++) {
            if (head[i] != 0 || head[i + 1] != 0) {
                continue;
            }
            int p; // start code の次のバイト位置
            if (head[i + 2] == 1) {
                p = i + 3;
            } else if (head[i + 2] == 0 && head[i + 3] == 1) {
                p = i + 4;
            } else {
                continue;
            }
            int b0 = head[p] & 0xFF;
            if (b0 == 0xB3 || b0 == 0xB8 || b0 == 0x00) {
                return Payload.MPEG2_ES; // sequence header / GOP / picture start code
            }
            if ((b0 & 0x80) == 0) {
                int h264Type = b0 & 0x1F;
                if (h264Type == 7 || h264Type == 5 || h264Type == 1 || h264Type == 8 || h264Type == 9) {
                    return Payload.H264_ES;
                }
                int hevcType = (b0 >> 1) & 0x3F;
                if (hevcType == 32 || hevcType == 33 || hevcType == 34 || hevcType == 19 || hevcType == 21) {
                    return Payload.HEVC_ES;
                }
            }
        }
        return Payload.UNKNOWN;
    }

    /**
     * ffmpeg コマンドを組み立てる。
     *
     * <p>H.264/HEVC の基本ストリームは <b>{@code -c:v copy}（remux）</b>＝再圧縮しないので画質劣化も
     * CPU コストも無い。MPEG2 等は取込側（{@code VideoConverter.transcodeCommand}）と同じ設定で
     * H.264 High@4.1 に再エンコードする（{@code -bf 0} でフレーム順序を保証）。
     * どちらも {@code +faststart} で moov を先頭に置き、Range シークを軽くする。
     *
     * <p>🚨 <b>基本ストリームには時間情報が無いので、入力側に {@code -r <fps>} を必ず渡す</b>
     * （DICOM の FrameTime/CineRate 由来）。省くと raw demuxer が既定 25fps を仮定し、さらに
     * <b>先頭フレームの PTS が 1 フレーム分ずれる</b>（実測: 30 フレームの動画が duration 2.067s になり、
     * 先頭フレームの PTS が 0 ではなく 0.066）。その結果 <b>「フレーム f の統計」が f−1 の値になる</b>
     * （2026-07-30 の実機検証で発覚）。{@code -r} を渡すと PTS が 0 から fps 刻みになり一致する。
     * ※ {@code -fps_mode} は ffmpeg 5.0 以降にしか無いので使わない（同梱 4.x で "Unrecognized option"）。
     */
    static List<String> buildCommand(String ffmpeg, Payload kind, Path in, Path out, double fps) {
        List<String> cmd = new ArrayList<>(List.of(ffmpeg, "-y"));
        if (kind == Payload.MPEG2_ES) {
            // 拡張子の無い一時ファイルなので入力形式を明示する（probe に任せると失敗しうる）。
            cmd.addAll(List.of("-f", "mpegvideo"));
        } else if (kind == Payload.H264_ES) {
            cmd.addAll(List.of("-f", "h264"));
        } else if (kind == Payload.HEVC_ES) {
            cmd.addAll(List.of("-f", "hevc"));
        }
        if (kind != Payload.MP4 && fps > 0) {
            cmd.addAll(List.of("-r", formatFps(fps)));
        }
        cmd.addAll(List.of("-i", in.toString(), "-an"));
        if (kind == Payload.H264_ES || kind == Payload.HEVC_ES) {
            cmd.addAll(List.of("-c:v", "copy"));
        } else {
            cmd.addAll(List.of("-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1",
                    "-bf", "0", "-pix_fmt", "yuv420p"));
        }
        cmd.addAll(List.of("-movflags", "+faststart", "-f", "mp4", out.toString()));
        return cmd;
    }

    private static void runFfmpeg(List<String> cmd, String sopUid, Payload kind) throws IOException {
        log.debug("ffmpeg ({} → mp4): {}", kind, String.join(" ", cmd));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String tail;
        try (InputStream is = p.getInputStream()) {
            tail = tail(new String(is.readAllBytes()));
        }
        try {
            if (!p.waitFor(FFMPEG_TIMEOUT_SEC, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                throw new IOException("ffmpeg timed out (sop=" + sopUid + ")");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            p.destroyForcibly();
            throw new IOException("ffmpeg interrupted", e);
        }
        if (p.exitValue() != 0) {
            log.warn("ffmpeg failed ({}) sop={}:\n{}", p.exitValue(), sopUid, tail);
            throw new IOException("ffmpeg failed (exit " + p.exitValue() + ", sop=" + sopUid + ")");
        }
    }

    /** {@code ffmpeg -version} が 0 で終了するか。 */
    static boolean ffmpegAvailable(String ffmpeg) {
        try {
            Process p = new ProcessBuilder(ffmpeg, "-version").redirectErrorStream(true).start();
            try (InputStream is = p.getInputStream()) {
                is.readAllBytes();
            }
            return p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * fps を ffmpeg に渡せる文字列にする。FrameTime 由来の fps は {@code 14.999999999999998} のような値に
     * なるため、整数に十分近ければ整数として渡す（{@code -r 15}）。
     */
    static String formatFps(double fps) {
        long rounded = Math.round(fps);
        if (rounded > 0 && Math.abs(fps - rounded) < 1e-6) {
            return Long.toString(rounded);
        }
        return String.format(java.util.Locale.ROOT, "%.6f", fps);
    }

    /** SOPInstanceUID をファイル名に使うためのサニタイズ（英数字とドットのみ、パストラバーサル防止）。 */
    static String cacheName(String sopUid) {
        String s = sopUid.replaceAll("[^0-9A-Za-z.]", "_");
        return s.length() <= 128 ? s : s.substring(0, 128);
    }

    private static String tail(String s) {
        int max = 2000;
        return s.length() <= max ? s : s.substring(s.length() - max);
    }
}
