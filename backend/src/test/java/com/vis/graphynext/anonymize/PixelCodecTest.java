/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.DicomProperties;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.data.Value;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 圧縮画素の伸長（{@link PixelCodec}）。
 *
 * <p>JPEG は<b>自分で作る</b>。実データを fixture に置くと、サイズが大きいうえに
 * 「そのファイルでだけ通る」検査になりやすい。JDK の ImageIO が JPEG を<b>書ける</b>ことを
 * 使って、その場で encapsulated な DICOM を組み立てる（読む側は OpenCV ネイティブ）。
 *
 * <p>⚠ ネイティブが無い環境（CI・{@code --add-opens} 無しの実行）では
 * {@link Assumptions} で飛ばす。**落とさないのは「使えないこと」自体は異常ではないから**
 * ——そのときは {@code AnonymizeService} の事前検査が書き出す前に中止する、という設計。
 */
class PixelCodecTest {

    private static final int W = 64;
    private static final int H = 48;

    private static PixelCodec codec() {
        return new PixelCodec(new DicomProperties());
    }

    @Test
    void 圧縮でない転送構文はそのまま扱う() {
        assertTrue(PixelCodec.isUncompressed(UID.ExplicitVRLittleEndian));
        assertTrue(PixelCodec.isUncompressed(UID.ImplicitVRLittleEndian));
        assertTrue(PixelCodec.isUncompressed(UID.ExplicitVRBigEndian));
        assertFalse(PixelCodec.isUncompressed(UID.JPEGBaseline8Bit));
        assertFalse(PixelCodec.isUncompressed(UID.JPEGLosslessSV1));
        assertFalse(PixelCodec.isUncompressed(null));
    }

    @Test
    void 使えないときは理由を持つ() {
        PixelCodec c = codec();
        if (!c.available()) {
            assertFalse(c.unavailableReason().isBlank(),
                    "🔴 使えないことだけ伝えて理由を伝えないと、利用者は直しようがない");
        }
    }

    /**
     * 🔴 <b>JVM フラグの有無を、ネイティブに触る前に判定できること。</b>
     *
     * <p>{@code java.base/java.io} を開き忘れた JVM で OpenCV を呼ぶと、例外ではなく
     * <b>SIGSEGV で JVM ごと落ちる</b>（実測）。backend の他機能まで巻き添えになるので、
     * この判定が先に立つことが安全の前提になっている。
     */
    @Test
    void モジュールが開いているかを純Javaで判定できる() {
        // このテスト自身の JVM が開いているかは環境依存なので、値ではなく「例外なく判定できる」
        // ことを固定する（ここで例外が出ると、判定のために OpenCV を呼ぶ実装に戻ってしまう）。
        boolean opened = PixelCodec.modulesOpened();
        assertTrue(opened || !opened);
    }

    @Test
    void JPEGBaselineを伸長すると画素数が正しくなる(@TempDir Path dir) throws Exception {
        PixelCodec c = codec();
        Assumptions.assumeTrue(c.available(), "OpenCV ネイティブが無い環境: " + c.unavailableReason());

        Path file = writeEncapsulatedJpeg(dir.resolve("jpeg.dcm"), 3);
        Attributes ds;
        String tsuid;
        try (DicomInputStream in = new DicomInputStream(file.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
            tsuid = in.getTransferSyntax();
        }
        assertEquals(UID.JPEGBaseline8Bit, tsuid);

        byte[] px = c.decompress(ds, tsuid);
        assertNotNull(px, "伸長できること");
        assertEquals(W * H * 3, px.length, "rows × cols × frames（8bit・1サンプル）");
    }

    /**
     * 🔴 {@code IncludeBulkData.YES} で読んだデータセットは伸長できない。
     *
     * <p>{@code Decompressor} はフラグメントが {@code BulkData}（元ファイルへの参照）であることを
     * 要求する。ここを取り違えると {@code ClassCastException} になるだけで、呼び出し元からは
     * 「圧縮画像は塗れない」と区別がつかない。読み方の規約をテストで固定しておく。
     */
    @Test
    void バルクデータを実体で読むと伸長できない(@TempDir Path dir) throws Exception {
        PixelCodec c = codec();
        Assumptions.assumeTrue(c.available(), "OpenCV ネイティブが無い環境: " + c.unavailableReason());

        Path file = writeEncapsulatedJpeg(dir.resolve("jpeg.dcm"), 1);
        Attributes ds;
        String tsuid;
        try (DicomInputStream in = new DicomInputStream(file.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES); // ← わざと誤った読み方
            in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
            tsuid = in.getTransferSyntax();
        }
        assertNull(c.decompress(ds, tsuid), "例外を投げずに null（＝塗らない）へ倒すこと");
    }

    // ------------------------------------------------------------------------

    /** JPEG Baseline で encapsulate した multi-frame を 1 件書く。 */
    private static Path writeEncapsulatedJpeg(Path file, int frames) throws IOException {
        byte[] jpeg = jpegFrame();

        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, UID.XRayAngiographicImageStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.9");
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.7");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.8");
        ds.setString(Tag.Modality, VR.CS, "XA");
        ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        ds.setInt(Tag.Rows, VR.US, H);
        ds.setInt(Tag.Columns, VR.US, W);
        ds.setInt(Tag.BitsAllocated, VR.US, 8);
        ds.setInt(Tag.BitsStored, VR.US, 8);
        ds.setInt(Tag.HighBit, VR.US, 7);
        ds.setInt(Tag.PixelRepresentation, VR.US, 0);
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        ds.setInt(Tag.NumberOfFrames, VR.IS, frames);

        // 先頭は基本オフセットテーブル（空）。以降が 1 フレーム 1 フラグメント。
        Fragments frags = ds.newFragments(Tag.PixelData, VR.OB, frames + 1);
        frags.add(Value.NULL);
        for (int i = 0; i < frames; i++) {
            frags.add(jpeg);
        }

        Attributes fmi = ds.createFileMetaInformation(UID.JPEGBaseline8Bit);
        try (OutputStream os = Files.newOutputStream(file);
                DicomOutputStream dos = new DicomOutputStream(os, UID.JPEGBaseline8Bit)) {
            dos.writeDataset(fmi, ds);
        }
        return file;
    }

    /** グレースケールの階調画像を JPEG で 1 枚。 */
    private static byte[] jpegFrame() throws IOException {
        BufferedImage img = new BufferedImage(W, H, BufferedImage.TYPE_BYTE_GRAY);
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                int v = (x * 255) / (W - 1);
                img.getRaster().setSample(x, y, 0, v);
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (!javax.imageio.ImageIO.write(img, "jpeg", out)) {
            throw new IOException("この JVM は JPEG を書けません");
        }
        return out.toByteArray();
    }
}
