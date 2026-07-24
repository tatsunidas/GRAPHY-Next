/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.video;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.BulkData;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Set;

/**
 * encapsulated video（PixelData に MP4 を格納した DICOM）から <b>ブラウザ再生可能な MP4 バイト列</b>を
 * 取り出すユーティリティ。{@code VideoRenderController} の {@code /rendered} / {@code /video-metadata} が使う。
 *
 * <p>取込済み Video Photographic（{@link com.vis.graphynext.nondicom.VideoConverter}）は
 * <b>MP4 全体を 1 フラグメント</b>として encapsulate している。ここでは Basic Offset Table（先頭 Item）を
 * 飛ばして残りのフラグメントを連結し、そのまま {@code video/mp4} として供給できる基本ストリームを作る。
 *
 * <p>P1 スコープでは <b>無変換で配信できる転送構文（H.264 / HEVC 系）</b>のみ対象。MPEG2 等
 * ブラウザ非対応の転送構文は {@link VideoMeta#transcodeRequired()} を {@code true} で返し、配信側で
 * ffmpeg 変換（P4）に委ねる。
 */
public final class VideoFragmentExtractor {

    private static final Logger log = LoggerFactory.getLogger(VideoFragmentExtractor.class);

    private VideoFragmentExtractor() {}

    /**
     * ブラウザが {@code <video>}/Cornerstone VideoViewport でそのまま再生できる転送構文
     * （フラグメント連結＝MP4 で無変換配信できるもの）。それ以外は ffmpeg 変換が要る。
     */
    private static final Set<String> NO_TRANSCODE_TS = Set.of(
            "1.2.840.10008.1.2.4.102", // MPEG-4 AVC/H.264 High Profile / Level 4.1
            "1.2.840.10008.1.2.4.103", // MPEG-4 AVC/H.264 BD-compatible High Profile / Level 4.1
            "1.2.840.10008.1.2.4.104", // MPEG-4 AVC/H.264 High Profile / Level 4.2 For 2D Video
            "1.2.840.10008.1.2.4.105", // MPEG-4 AVC/H.264 High Profile / Level 4.2 For 3D Video
            "1.2.840.10008.1.2.4.106", // MPEG-4 AVC/H.264 Stereo High Profile / Level 4.2
            "1.2.840.10008.1.2.4.107", // HEVC/H.265 Main Profile / Level 5.1
            "1.2.840.10008.1.2.4.108"  // HEVC/H.265 Main 10 Profile / Level 5.1
    );

    /** 再生 UI / フレーム換算に必要な動画諸元（ヘッダのみから導出）。 */
    public record VideoMeta(
            int rows, int columns, int numberOfFrames,
            double fps, Double frameTimeMs, Double cineRate, Double durationSec,
            String transferSyntaxUid, boolean transcodeRequired) {}

    /**
     * ヘッダ（ピクセル無し）から動画諸元を読む。{@code fps} は FrameTime(0018,1063) 優先、無ければ
     * CineRate(0018,0040)。{@code durationSec} は {@code numberOfFrames/fps}（fps 不明なら null）。
     */
    public static VideoMeta readMeta(Path dcm) throws IOException {
        Attributes fmi;
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(dcm.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            fmi = in.readFileMetaInformation();
            ds = in.readDatasetUntilPixelData();
        }
        String tsuid = fmi != null ? fmi.getString(Tag.TransferSyntaxUID) : null;
        int rows = ds.getInt(Tag.Rows, 0);
        int cols = ds.getInt(Tag.Columns, 0);
        int nFrames = Math.max(1, ds.getInt(Tag.NumberOfFrames, 1));
        Double frameTime = readNumeric(ds, Tag.FrameTime);
        Double cineRate = readNumeric(ds, Tag.CineRate);
        double fps = (frameTime != null && frameTime > 0) ? 1000.0 / frameTime
                : (cineRate != null && cineRate > 0 ? cineRate : 0.0);
        Double duration = fps > 0 ? nFrames / fps : null;
        boolean transcode = tsuid == null || !NO_TRANSCODE_TS.contains(tsuid);
        return new VideoMeta(rows, cols, nFrames, fps, frameTime, cineRate, duration, tsuid, transcode);
    }

    /**
     * encapsulated PixelData から MP4 バイト列を抽出して {@code dest} に書き出す（親ディレクトリは自動作成）。
     * 一時ファイルに書いてから原子的に move するので、並行取得で壊れた MP4 を配信することはない。
     *
     * @throws IOException PixelData が encapsulated でない／フラグメントが空
     */
    public static void extractTo(Path dcm, Path dest) throws IOException {
        Files.createDirectories(dest.getParent());
        Path tmp = Files.createTempFile(dest.getParent(), "vid-", ".part");
        try {
            long written;
            try (DicomInputStream in = new DicomInputStream(dcm.toFile());
                 OutputStream out = new BufferedOutputStream(Files.newOutputStream(tmp))) {
                in.setIncludeBulkData(IncludeBulkData.YES);
                in.readFileMetaInformation();
                Attributes ds = in.readDataset(-1, -1);
                Object pd = ds.getValue(Tag.PixelData);
                if (!(pd instanceof Fragments frags)) {
                    throw new IOException("PixelData is not encapsulated video: " + dcm.getFileName());
                }
                written = 0;
                // index 0 = Basic Offset Table（空 or フレームオフセット表）。1.. = 動画フラグメント。
                // 取込済み動画は 1 フラグメント = MP4 全体。複数フラグメント（BOT でフレーム分割された
                // 正規 DICOM video）は連結して 1 本の基本ストリームにする。
                for (int i = 1; i < frags.size(); i++) {
                    Object f = frags.get(i);
                    byte[] b;
                    if (f instanceof byte[] arr) {
                        b = arr;
                    } else if (f instanceof BulkData bd) {
                        b = bd.toBytes(VR.OB, false);
                    } else {
                        continue;
                    }
                    out.write(b);
                    written += b.length;
                }
                out.flush();
            }
            if (written == 0) {
                throw new IOException("no video fragment bytes: " + dcm.getFileName());
            }
            try {
                Files.move(tmp, dest, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicFailed) {
                // ファイルシステムが原子的 move 非対応（例: 一部 Windows 構成）→ 通常 move にフォールバック。
                Files.move(tmp, dest, StandardCopyOption.REPLACE_EXISTING);
            }
            log.debug("extracted video MP4: {} -> {} ({} bytes)", dcm.getFileName(), dest.getFileName(), written);
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    /**
     * 数値タグを VR 非依存で読む（IS/DS 双方を文字列パースで扱う。{@code getDouble} は IS を解釈できず
     * 都度警告ログを出すため使わない）。読めなければ null。
     */
    private static Double readNumeric(Attributes ds, int tag) {
        if (!ds.contains(tag)) {
            return null;
        }
        String s = ds.getString(tag);
        if (s == null || s.isBlank()) {
            return null;
        }
        try {
            return Double.parseDouble(s.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
