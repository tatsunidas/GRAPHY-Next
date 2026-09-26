/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.video;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.DoubleConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 動画ファイルの諸元と指紋（host API の H47 {@code video.probe}）。
 *
 * <h3>ffprobe を使わない</h3>
 * 本体が同梱しているのは ffmpeg だけで、ffprobe は無い。諸元は {@code ffmpeg -i} が標準エラーに出す
 * ストリーム情報から読み、<b>フレーム数だけは数え直す</b>（{@code -c copy -f null}：デコードせずに
 * パケットを数えるので速い）。コンテナのヘッダのフレーム数や「尺 × fps」は AVI で平気でずれるので使わない。
 *
 * <h3>指紋（SHA-256）と UID</h3>
 * 同じ動画の重複取り込みを防ぐため、動画の SOP / Series UID を<b>元ファイルの SHA-256 から決める</b>
 * （{@link #uidFrom}）。同じファイルなら何度取り込んでも同じ UID になり、既にあれば保管庫で見つかる。
 */
public final class VideoProbe {

    private VideoProbe() {
    }

    /** 諸元。{@code frameCount} は数え直した値。 */
    public record Info(
            String path,
            String fileName,
            long sizeBytes,
            String sha256,
            String codec,
            int width,
            int height,
            double fps,
            int frameCount,
            double durationSec) {
    }

    private static final Pattern VIDEO_STREAM = Pattern.compile(
            "Stream #\\d+:\\d+[^:]*: Video: (\\w+)[^\\n]*?, (\\d{2,5})x(\\d{2,5})[ ,\\[]");
    private static final Pattern FPS = Pattern.compile("(\\d+(?:\\.\\d+)?) fps");
    private static final Pattern TBR = Pattern.compile("(\\d+(?:\\.\\d+)?) tbr");
    private static final Pattern DURATION = Pattern.compile("Duration: (\\d+):(\\d{2}):(\\d{2}(?:\\.\\d+)?)");
    private static final Pattern FRAME = Pattern.compile("frame=\\s*(\\d+)");

    /** 指紋の覚え書き（同じファイルを probe と取り込みで 2 回読まない）。鍵は パス・大きさ・更新時刻。 */
    private static final Map<String, String> SHA_CACHE = new ConcurrentHashMap<>();

    /**
     * 諸元を調べる。
     *
     * @param onHashProgress 指紋の計算の進み具合（0〜1）。null 可
     * @throws IOException ffmpeg が動かない / 動画のストリームが無い
     */
    public static Info probe(String ffmpeg, Path file, DoubleConsumer onHashProgress) throws IOException {
        if (!Files.isRegularFile(file)) throw new IOException("ファイルがありません: " + file);
        String sha = sha256(file, onHashProgress);
        String header = run(List.of(ffmpeg, "-hide_banner", "-nostdin", "-i", file.toString()), 60);
        Header hd = parseHeader(header);
        if (hd == null) throw new IOException("動画のストリームが見つかりません: " + file.getFileName());
        String counted = run(List.of(ffmpeg, "-hide_banner", "-nostdin", "-i", file.toString(),
                "-map", "0:v:0", "-c", "copy", "-f", "null", "-"), 600);
        long size = Files.size(file);
        return new Info(file.toString(), file.getFileName().toString(), size, sha, hd.codec(), hd.width(),
                hd.height(), hd.fps(), lastFrameCount(counted), hd.durationSec());
    }

    /** {@code ffmpeg -i} の出力から読んだ映像ストリームの諸元。 */
    record Header(String codec, int width, int height, double fps, double durationSec) {
    }

    /** {@code ffmpeg -i} の出力を読む。映像ストリームが無ければ null。 */
    static Header parseHeader(String header) {
        Matcher m = VIDEO_STREAM.matcher(header);
        if (!m.find()) return null;
        int eol = header.indexOf('\n', m.start());
        String streamLine = header.substring(m.start(), eol < 0 ? header.length() : eol);
        double fps = firstDouble(FPS, streamLine);
        if (!(fps > 0)) fps = firstDouble(TBR, streamLine);
        double duration = 0;
        Matcher d = DURATION.matcher(header);
        if (d.find()) {
            duration = Integer.parseInt(d.group(1)) * 3600 + Integer.parseInt(d.group(2)) * 60
                    + Double.parseDouble(d.group(3));
        }
        return new Header(m.group(1), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)),
                fps > 0 ? fps : 0, duration);
    }

    /** {@code -c copy -f null} の出力の最後の {@code frame=N}（＝総数）。 */
    static int lastFrameCount(String out) {
        int frames = 0;
        Matcher f = FRAME.matcher(out);
        while (f.find()) frames = Integer.parseInt(f.group(1));
        return frames;
    }

    /** SHA-256（16 進）。同じファイル（パス・大きさ・更新時刻が同じ）は覚えておいた値を返す。 */
    public static String sha256(Path file, DoubleConsumer onProgress) throws IOException {
        long size = Files.size(file);
        String key = file.toAbsolutePath() + "|" + size + "|" + Files.getLastModifiedTime(file).toMillis();
        String hit = SHA_CACHE.get(key);
        if (hit != null) {
            if (onProgress != null) onProgress.accept(1);
            return hit;
        }
        MessageDigest md = sha256();
        byte[] buf = new byte[1 << 20];
        long done = 0;
        try (InputStream in = Files.newInputStream(file)) {
            for (int n; (n = in.read(buf)) > 0; ) {
                md.update(buf, 0, n);
                done += n;
                if (onProgress != null && size > 0) onProgress.accept((double) done / size);
            }
        }
        String hex = HexFormat.of().formatHex(md.digest());
        SHA_CACHE.put(key, hex);
        return hex;
    }

    /**
     * 名前空間つきで UID を決める（{@code 2.25.<128 bit>}。UUID の名前ベースと同じ作法を SHA-256 で）。
     * 同じ名前空間・同じ値なら必ず同じ UID になる。
     */
    public static String uidFrom(String namespace, String value) {
        byte[] h = sha256().digest((namespace + "\n" + value).getBytes(StandardCharsets.UTF_8));
        byte[] b = java.util.Arrays.copyOf(h, 16);
        b[6] = (byte) ((b[6] & 0x0f) | 0x50); // version 5 相当（名前ベース）
        b[8] = (byte) ((b[8] & 0x3f) | 0x80); // variant
        return "2.25." + new BigInteger(1, b);
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static double firstDouble(Pattern p, String s) {
        Matcher m = p.matcher(s);
        return m.find() ? Double.parseDouble(m.group(1)) : 0;
    }

    /** ffmpeg を走らせて標準エラー（＝情報の出力先）を返す。{@code -i} だけのときは終了コード 1 が正常。 */
    static String run(List<String> cmd, int timeoutSec) throws IOException {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String out;
        try (InputStream is = p.getInputStream()) {
            out = new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
        try {
            if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                throw new IOException("ffmpeg timed out");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            p.destroyForcibly();
            throw new IOException("ffmpeg interrupted", e);
        }
        return out;
    }
}
