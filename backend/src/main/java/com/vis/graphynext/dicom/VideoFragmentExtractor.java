/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.BulkData;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

/**
 * encapsulated video（Video Photographic/Endoscopic/Microscopic ほか MPEG/H.264/HEVC）を格納した
 * DICOM Part-10 から、再生用の基本ストリーム（MP4 等）を取り出すユーティリティ。
 *
 * <p>取込側 {@link com.vis.graphynext.nondicom.VideoConverter} は「MP4 全体を 1 フラグメント」として
 * encapsulated PixelData に格納する。モダリティ由来の正規 DICOM video は Basic Offset Table（BOT）で
 * フレーム分割された複数フラグメントの場合がある。いずれも <b>先頭アイテム（BOT）を飛ばし、以降の
 * フラグメントを連結</b>すれば元の基本ストリームになる（BOT はフレーム境界であってコンテナ分割ではない）。
 *
 * <p>本クラスはピクセルをデコードしない（フラグメントのバイト列をそのまま連結するだけ）。よって
 * ブラウザがそのコーデックを再生できる転送構文（H.264/HEVC in MP4）のときのみ「無変換で配信可能」。
 * MPEG2 等は ffmpeg 変換が要る（P4）。判定は {@link #isBrowserPlayable(String)}。
 */
public final class VideoFragmentExtractor {

    private VideoFragmentExtractor() {}

    /**
     * 無変換でブラウザ（{@code <video>}/Cornerstone VideoViewport）が再生できる video 転送構文。
     * H.264(MPEG-4 AVC) 102–106 と HEVC 107/108（＋ フレーム分割 {@code .1} 変種）。MPEG2(100/101) は除外。
     */
    private static final Set<String> BROWSER_PLAYABLE_TS = Set.of(
            UID.MPEG4HP41, UID.MPEG4HP41F,
            UID.MPEG4HP41BD, UID.MPEG4HP41BDF,
            UID.MPEG4HP422D, UID.MPEG4HP422DF,
            UID.MPEG4HP423D, UID.MPEG4HP423DF,
            UID.MPEG4HP42STEREO, UID.MPEG4HP42STEREOF,
            UID.HEVCMP51, UID.HEVCM10P51);

    /** その転送構文が無変換でブラウザ再生できるか（true=そのまま video/mp4 配信可）。 */
    public static boolean isBrowserPlayable(String transferSyntaxUid) {
        return transferSyntaxUid != null && BROWSER_PLAYABLE_TS.contains(transferSyntaxUid);
    }

    /** 再生 UI に必要な諸元（ピクセルは読まない）。 */
    public record VideoInfo(int rows, int columns, int numberOfFrames,
                            double frameTimeMs, double cineRate, String transferSyntaxUid) {

        /** 無変換配信できる転送構文か。 */
        public boolean playable() {
            return isBrowserPlayable(transferSyntaxUid);
        }

        /** フレームレート（fps）。FrameTime[ms] 優先、無ければ CineRate、いずれも無ければ 0。 */
        public double fps() {
            if (frameTimeMs > 0) {
                return 1000.0 / frameTimeMs;
            }
            return Math.max(cineRate, 0);
        }
    }

    /** ヘッダのみ読んで諸元と転送構文を返す（PixelData は読まない）。 */
    public static VideoInfo readInfo(Path dicom) throws IOException {
        try (DicomInputStream dis = new DicomInputStream(dicom.toFile())) {
            dis.setIncludeBulkData(IncludeBulkData.NO);
            Attributes ds = dis.readDatasetUntilPixelData();
            String ts = dis.getTransferSyntax();
            return new VideoInfo(
                    ds.getInt(Tag.Rows, 0),
                    ds.getInt(Tag.Columns, 0),
                    ds.getInt(Tag.NumberOfFrames, 0),
                    ds.getDouble(Tag.FrameTime, 0),
                    ds.getDouble(Tag.CineRate, 0),
                    ts);
        }
    }

    /**
     * encapsulated PixelData のフラグメント（BOT を除く全て）を連結して {@code out} に書き出す。
     *
     * @return 書き出したバイト数
     * @throws IOException PixelData が encapsulated（Fragments）でない場合を含む
     */
    public static long extractTo(Path dicom, Path out) throws IOException {
        try (DicomInputStream dis = new DicomInputStream(dicom.toFile())) {
            dis.setIncludeBulkData(IncludeBulkData.YES); // フラグメントを byte[] として読み込む
            Attributes ds = dis.readDataset();
            Object pixelData = ds.getValue(Tag.PixelData);
            if (!(pixelData instanceof Fragments frags)) {
                throw new IOException("PixelData is not encapsulated (no fragments): " + dicom.getFileName());
            }
            long written = 0;
            try (OutputStream os = new BufferedOutputStream(Files.newOutputStream(out))) {
                // index 0 = Basic Offset Table。飛ばして 1.. を連結。
                for (int i = 1; i < frags.size(); i++) {
                    written += writeFragment(frags.get(i), os);
                }
            }
            return written;
        }
    }

    private static long writeFragment(Object fragment, OutputStream os) throws IOException {
        if (fragment instanceof byte[] bytes) {
            os.write(bytes);
            return bytes.length;
        }
        if (fragment instanceof BulkData bulk) {
            try (InputStream in = bulk.openStream()) {
                return in.transferTo(os);
            }
        }
        return 0; // Value.NULL 等（空フラグメント）
    }
}
