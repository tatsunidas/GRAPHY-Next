/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.video;

import com.vis.graphynext.dicom.video.VideoFragmentExtractor.VideoMeta;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * encapsulated video からの MP4 抽出・メタ導出（{@link VideoFragmentExtractor}）の検証。
 * {@code VideoConverter} と同じ「MP4 全体を 1 フラグメント」形式の Part-10 を合成して round-trip する。
 */
class VideoFragmentExtractorTest {

    /** H.264 High@L4.1（取込済み動画が使う無変換対象の転送構文）。 */
    private static final String H264_HIGH_41 = "1.2.840.10008.1.2.4.102";

    /** {@code VideoConverter.writeEncapsulated} と同形式で、payload を 1 フラグメントにした動画 DICOM を書く。 */
    private static void writeVideoDicom(Path out, String tsuid, byte[] payload,
                                        int rows, int cols, int frames, double frameTimeMs) throws IOException {
        Attributes attrs = new Attributes();
        attrs.setString(Tag.SOPClassUID, VR.UI, UID.VideoPhotographicImageStorage);
        attrs.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.StudyInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.Modality, VR.CS, "XC");
        attrs.setInt(Tag.Rows, VR.US, rows);
        attrs.setInt(Tag.Columns, VR.US, cols);
        attrs.setInt(Tag.NumberOfFrames, VR.IS, frames);
        attrs.setDouble(Tag.FrameTime, VR.DS, frameTimeMs);

        long len = payload.length;
        boolean odd = (len & 1L) != 0;
        long itemLen = odd ? len + 1 : len;
        Attributes fmi = attrs.createFileMetaInformation(tsuid);
        try (DicomOutputStream dos = new DicomOutputStream(out.toFile())) {
            dos.writeDataset(fmi, attrs);
            dos.writeHeader(Tag.PixelData, VR.OB, -1);       // undefined length = encapsulated
            dos.writeHeader(Tag.Item, null, 0);              // 空 Basic Offset Table
            dos.writeHeader(Tag.Item, null, (int) itemLen);  // 1 フラグメント = MP4 全体
            dos.write(payload);
            if (odd) {
                dos.write(0);
            }
            dos.writeHeader(Tag.SequenceDelimitationItem, null, 0);
        }
    }

    @Test
    void extractTo_roundTripsEncapsulatedMp4(@TempDir Path dir) throws IOException {
        byte[] payload = "PSEUDO-MP4-BYTES0123456789ABCDEF".getBytes(StandardCharsets.US_ASCII); // 32 byte（偶数長）
        assertEquals(0, payload.length % 2, "テスト前提: payload は偶数長（末尾 pad なし）");
        Path dcm = dir.resolve("video.dcm");
        writeVideoDicom(dcm, H264_HIGH_41, payload, 480, 640, 30, 33.3);

        Path mp4 = dir.resolve("out").resolve("extracted.mp4");
        VideoFragmentExtractor.extractTo(dcm, mp4);

        assertTrue(Files.exists(mp4), "抽出 MP4 が出力されること（親 dir 自動作成含む）");
        assertArrayEquals(payload, Files.readAllBytes(mp4), "フラグメント（=MP4 全体）がそのまま取り出せること");
    }

    @Test
    void extractTo_skipsBasicOffsetTableFragment(@TempDir Path dir) throws IOException {
        // BOT（index 0）を誤って含めないこと。payload の先頭が保たれることで確認。
        byte[] payload = new byte[64];
        Arrays.fill(payload, (byte) 0xAB);
        payload[0] = 0x11;
        payload[63] = 0x22;
        Path dcm = dir.resolve("v2.dcm");
        writeVideoDicom(dcm, H264_HIGH_41, payload, 100, 100, 10, 40.0);

        Path mp4 = dir.resolve("v2.mp4");
        VideoFragmentExtractor.extractTo(dcm, mp4);
        assertArrayEquals(payload, Files.readAllBytes(mp4));
    }

    @Test
    void readMeta_derivesFpsAndTranscodeFlag(@TempDir Path dir) throws IOException {
        Path dcm = dir.resolve("meta.dcm");
        writeVideoDicom(dcm, H264_HIGH_41, "abcd".getBytes(StandardCharsets.US_ASCII), 480, 640, 30, 40.0);

        VideoMeta m = VideoFragmentExtractor.readMeta(dcm);
        assertEquals(480, m.rows());
        assertEquals(640, m.columns());
        assertEquals(30, m.numberOfFrames());
        assertEquals(25.0, m.fps(), 1e-6, "fps = 1000 / FrameTime(40ms) = 25");
        assertEquals(H264_HIGH_41, m.transferSyntaxUid());
        assertFalse(m.transcodeRequired(), "H.264 は無変換で配信可");
    }

    @Test
    void readMeta_flagsTranscodeForNonBrowserCodec(@TempDir Path dir) throws IOException {
        // MPEG2 MP@ML（ブラウザ非対応）→ transcodeRequired=true。
        String mpeg2 = "1.2.840.10008.1.2.4.100";
        Path dcm = dir.resolve("mpeg2.dcm");
        writeVideoDicom(dcm, mpeg2, "abcd".getBytes(StandardCharsets.US_ASCII), 480, 640, 30, 40.0);

        VideoMeta m = VideoFragmentExtractor.readMeta(dcm);
        assertTrue(m.transcodeRequired(), "MPEG2 は ffmpeg 変換が必要（P4）");
    }

    @Test
    void extractTo_throwsWhenNotEncapsulated(@TempDir Path dir) throws IOException {
        // ネイティブ（非 encapsulated）PixelData の単純な画像 → Fragments でないので抽出不可。
        Attributes attrs = new Attributes();
        attrs.setString(Tag.SOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
        attrs.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.StudyInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setInt(Tag.Rows, VR.US, 4);
        attrs.setInt(Tag.Columns, VR.US, 4);
        attrs.setInt(Tag.BitsAllocated, VR.US, 8);
        attrs.setInt(Tag.SamplesPerPixel, VR.US, 1);
        attrs.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        attrs.setBytes(Tag.PixelData, VR.OB, new byte[16]);
        Path dcm = dir.resolve("native.dcm");
        Attributes fmi = attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian);
        try (DicomOutputStream dos = new DicomOutputStream(dcm.toFile())) {
            dos.writeDataset(fmi, attrs);
        }

        assertThrows(IOException.class, () -> VideoFragmentExtractor.extractTo(dcm, dir.resolve("no.mp4")));
    }

    @Test
    void extractTo_dropsTrailingPadByteAgnostic_oddPayload(@TempDir Path dir) throws IOException {
        // 奇数長 payload は encapsulate 時に 1 byte pad される。抽出結果は payload+pad（末尾 0）になる。
        // ブラウザ MP4 は末尾余剰バイトを無視するため許容。ここでは「本体が先頭から保たれる」ことを確認する。
        byte[] payload = "ODD-LENGTH-MP4".getBytes(StandardCharsets.US_ASCII); // 14? -> ensure odd
        byte[] odd = Arrays.copyOf(payload, 15);
        odd[14] = 0x7F;
        Path dcm = dir.resolve("odd.dcm");
        writeVideoDicom(dcm, H264_HIGH_41, odd, 10, 10, 1, 100.0);

        Path mp4 = dir.resolve("odd.mp4");
        VideoFragmentExtractor.extractTo(dcm, mp4);
        byte[] got = Files.readAllBytes(mp4);
        assertEquals(16, got.length, "奇数長は偶数へ pad される");
        assertArrayEquals(odd, Arrays.copyOf(got, 15), "本体は先頭から一致");
        assertEquals(0, got[15], "末尾は pad の 0");
    }

    /** ffmpeg 由来の警告を避けるため、リソースを閉じ切ることの回帰確認（open handle が残ると Windows で move 失敗）。 */
    @Test
    void extractTo_isReRunnableOverExistingCache(@TempDir Path dir) throws IOException {
        byte[] payload = "REPEATABLE-EXTRACT".getBytes(StandardCharsets.US_ASCII);
        byte[] even = Arrays.copyOf(payload, payload.length + (payload.length % 2)); // 偶数化
        Path dcm = dir.resolve("rerun.dcm");
        writeVideoDicom(dcm, H264_HIGH_41, even, 10, 10, 1, 100.0);
        Path mp4 = dir.resolve("cache").resolve("rerun.mp4");
        VideoFragmentExtractor.extractTo(dcm, mp4);
        VideoFragmentExtractor.extractTo(dcm, mp4); // 2 回目（既存キャッシュ上書き）が例外なく成功すること
        try (InputStream in = Files.newInputStream(mp4)) {
            assertArrayEquals(even, in.readAllBytes());
        }
    }
}
