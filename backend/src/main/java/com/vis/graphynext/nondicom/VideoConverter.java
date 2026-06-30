/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nondicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.imageio.codec.mp4.MP4Parser;
import org.dcm4che3.io.DicomOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * 一般動画（MP4/AVI）を DICOM 化する（Video Photographic Image Storage）。
 *
 * <p>方針: dcm4che {@link MP4Parser} で MP4(H.264/HEVC) のストリームを解析し、Rows/Columns/
 * NumberOfFrames/FrameTime と転送構文を得て、<b>MP4 全体を 1 フラグメントとして encapsulate</b> した
 * Part-10 を書き出す（jpg2dcm と同じ正攻法）。
 *
 * <p>MP4 が H.264/HEVC でない、または AVI の場合は <b>ffmpeg でトランスコード</b>してから取り込む
 * （ffmpeg が無ければ非対応として {@link UnsupportedOperationException}）。
 */
public final class VideoConverter {

    private static final Logger log = LoggerFactory.getLogger(VideoConverter.class);

    private VideoConverter() {}

    /**
     * 動画を DICOM(Part-10) として {@code out} に書き出す。
     *
     * @param ffmpeg ffmpeg 実行パス（既定 "ffmpeg"）。MP4 直読みできない時のトランスコードに使う。
     * @throws UnsupportedOperationException 取り込めない形式（ffmpeg 不在で非 H.264 MP4 / AVI 等）
     */
    public static void writeVideoDicom(NonDicomConverter.Ctx ctx, Path video, Path out, String ffmpeg)
            throws IOException {
        boolean isMp4 = video.getFileName().toString().toLowerCase().endsWith(".mp4");
        Path source = video;
        Path transcoded = null;
        try {
            Parsed parsed = isMp4 ? tryParse(video) : null;
            if (parsed == null) {
                // AVI、または H.264/対応プロファイルでない MP4 → ffmpeg でトランスコード
                if (!ffmpegAvailable(ffmpeg)) {
                    throw new UnsupportedOperationException(
                            "video requires ffmpeg (not installed): " + video.getFileName());
                }
                transcoded = transcodeToMp4(video, ffmpeg);
                source = transcoded;
                parsed = tryParse(transcoded);
                if (parsed == null) {
                    throw new UnsupportedOperationException("unsupported video after transcode");
                }
            }
            Attributes attrs = NonDicomConverter.common(ctx);
            attrs.setString(Tag.SOPClassUID, VR.UI, UID.VideoPhotographicImageStorage);
            parsed.parser.getAttributes(attrs); // Rows/Columns/NumberOfFrames/FrameTime/...
            writeEncapsulated(attrs, parsed.tsuid, source, out);
        } finally {
            if (transcoded != null) {
                Files.deleteIfExists(transcoded);
            }
        }
    }

    private record Parsed(MP4Parser parser, String tsuid) {}

    /** MP4 を解析して parser と転送構文を返す。解析不可/非対応プロファイルなら null。 */
    private static Parsed tryParse(Path mp4) {
        try (SeekableByteChannel ch = Files.newByteChannel(mp4, StandardOpenOption.READ)) {
            MP4Parser parser = new MP4Parser(ch);
            String tsuid = parser.getTransferSyntaxUID(); // 非対応プロファイルは例外
            return new Parsed(parser, tsuid);
        } catch (Exception e) {
            log.debug("mp4 parse 不可: {} ({})", mp4.getFileName(), e.toString());
            return null;
        }
    }

    /** attrs（PixelData 無し）＋ encapsulated PixelData（MP4 全体を 1 フラグメント）で Part-10 を書く。 */
    private static void writeEncapsulated(Attributes attrs, String tsuid, Path video, Path out) throws IOException {
        long len = Files.size(video);
        boolean odd = (len & 1L) != 0;
        long itemLen = odd ? len + 1 : len;
        if (itemLen > Integer.MAX_VALUE) {
            throw new IOException("video too large for a single fragment: " + len + " bytes");
        }
        Attributes fmi = attrs.createFileMetaInformation(tsuid);
        try (DicomOutputStream dos = new DicomOutputStream(out.toFile())) {
            dos.writeDataset(fmi, attrs);
            dos.writeHeader(Tag.PixelData, VR.OB, -1);   // undefined length = encapsulated
            dos.writeHeader(Tag.Item, null, 0);          // 空の Basic Offset Table
            dos.writeHeader(Tag.Item, null, (int) itemLen);
            try (InputStream in = Files.newInputStream(video)) {
                in.transferTo(dos);
            }
            if (odd) {
                dos.write(0); // フラグメントは偶数長
            }
            dos.writeHeader(Tag.SequenceDelimitationItem, null, 0);
        }
    }

    /** AVI / 非対応 MP4 → H.264 High@L4.1 の MP4 へトランスコード（音声無し, faststart）。 */
    private static Path transcodeToMp4(Path input, String ffmpeg) throws IOException {
        Path out = Files.createTempFile("nondicom-transcode-", ".mp4");
        List<String> cmd = List.of(
                ffmpeg, "-y", "-i", input.toString(),
                "-an",                       // 音声を除去（DICOM video は映像のみ扱い）
                "-c:v", "libx264",
                "-profile:v", "high", "-level:v", "4.1",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                out.toString());
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            String log0;
            try (InputStream is = p.getInputStream()) {
                log0 = new String(is.readAllBytes());
            }
            boolean done = p.waitFor(10, TimeUnit.MINUTES);
            if (!done) {
                p.destroyForcibly();
                throw new IOException("ffmpeg timed out");
            }
            if (p.exitValue() != 0) {
                Files.deleteIfExists(out);
                log.warn("ffmpeg failed ({}):\n{}", p.exitValue(), tail(log0));
                throw new IOException("ffmpeg transcode failed (exit " + p.exitValue() + ")");
            }
            return out;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Files.deleteIfExists(out);
            throw new IOException("ffmpeg interrupted", e);
        }
    }

    /** ffmpeg が利用可能か（`ffmpeg -version` が 0 で終了するか）。 */
    static boolean ffmpegAvailable(String ffmpeg) {
        try {
            Process p = new ProcessBuilder(ffmpeg, "-version").redirectErrorStream(true).start();
            try (InputStream is = p.getInputStream()) {
                is.readAllBytes();
            }
            return p.waitFor(15, TimeUnit.SECONDS) && p.exitValue() == 0;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return false;
        }
    }

    private static String tail(String s) {
        if (s == null) {
            return "";
        }
        String[] lines = s.split("\n");
        int from = Math.max(0, lines.length - 8);
        return String.join("\n", java.util.Arrays.copyOfRange(lines, from, lines.length));
    }
}
