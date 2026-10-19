/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.DicomProperties;
import ij.process.FloatProcessor;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.imageio.codec.Transcoder;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * テクスチャ解析の画素ローダ（{@link RadiomicsMapEngine#readSlice}）が、圧縮 DICOM を非圧縮と同じ値で読むこと。
 *
 * <p>テクスチャマップ・GLAM 解析・ROI 特徴量表は、このローダの出す画素だけを入力にする。だから
 * 「可逆圧縮でも全画素が非圧縮とビット一致」を確かめれば、3 つの計算も一致する（実アプリでの一致は
 * スパイクで確かめる）。圧縮データはその場で作る: JPEG 系は dcm4che の {@link Transcoder}（OpenCV
 * ネイティブ）、RLE は dcm4che に書き手が無いので、この試験の中で PS3.5 Annex G のとおりに符号化する
 * （読む側の dcm4che とは別の実装）。
 *
 * <p>⚠ ネイティブが無い環境（CI など）では JPEG 系の試験を飛ばす（未達として数える）。
 */
class RadiomicsCompressedInputTest {

    private static final int W = 64, H = 48;

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    private static PixelCodec codec() {
        return new PixelCodec(new DicomProperties());
    }

    /** CT 相当: 符号付き 16 bit（負の値を含む）か、符号なし 12 bit＋Rescale。 */
    private static Attributes phantom(boolean signed, int z) {
        Attributes a = new Attributes();
        String sop = "1.2.826.0.1.3680043.10.999." + (signed ? 1 : 2) + "." + z;
        a.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        a.setString(Tag.SOPInstanceUID, VR.UI, sop);
        a.setString(Tag.StudyInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.999.0");
        a.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.999." + (signed ? 1 : 2));
        a.setString(Tag.Modality, VR.CS, "CT");
        a.setInt(Tag.Rows, VR.US, H);
        a.setInt(Tag.Columns, VR.US, W);
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, signed ? 16 : 12);
        a.setInt(Tag.HighBit, VR.US, signed ? 15 : 11);
        a.setInt(Tag.PixelRepresentation, VR.US, signed ? 1 : 0);
        a.setString(Tag.RescaleIntercept, VR.DS, signed ? "0" : "-1024");
        a.setString(Tag.RescaleSlope, VR.DS, "1");
        byte[] px = new byte[W * H * 2];
        long s = 12345L + z;
        for (int i = 0; i < W * H; i++) {
            s = s * 6364136223846793005L + 1442695040888963407L;
            int x = i % W, y = i / W;
            // 負の値（空気・脂肪）から骨まで。乱数で隣り合う値の差を大きくし、予測符号化の境目も通す
            int v = signed ? (-1000 + (x * 37 + y * 11 + z * 5) % 2600 + (int) Math.floorMod(s >> 40, 64))
                    : ((x * 53 + y * 7 + z * 3) % 4000 + (int) Math.floorMod(s >> 40, 64));
            px[2 * i] = (byte) v;
            px[2 * i + 1] = (byte) (v >> 8);
        }
        a.setBytes(Tag.PixelData, VR.OW, px);
        return a;
    }

    private static Path write(Path dir, String name, Attributes ds, String ts) throws IOException {
        Path p = dir.resolve(name);
        try (DicomOutputStream out = new DicomOutputStream(p.toFile())) {
            out.writeDataset(ds.createFileMetaInformation(ts), ds);
        }
        return p;
    }

    private static Path transcode(Path src, Path dst, String ts) throws IOException {
        try (Transcoder t = new Transcoder(src.toFile())) {
            t.setIncludeFileMetaInformation(true);
            t.setDestinationTransferSyntax(ts);
            t.transcode((tr, ds) -> Files.newOutputStream(dst));
        }
        return dst;
    }

    private static float[] pixels(RadiomicsMapEngine.Loaded l) {
        assertNotNull(l);
        return (float[]) ((FloatProcessor) l.ip()).getPixels();
    }

    @Test
    void losslessCompressionReadsTheSameValuesAsUncompressed(@TempDir Path dir) throws Exception {
        PixelCodec codec = codec();
        Assumptions.assumeTrue(codec.available(), () -> "OpenCV ネイティブが無い: " + codec.unavailableReason());
        for (boolean signed : new boolean[] {true, false}) {
            for (int z = 0; z < 3; z++) {
                Attributes ds = phantom(signed, z);
                Path raw = write(dir, "raw-" + signed + z + ".dcm", ds, UID.ExplicitVRLittleEndian);
                RadiomicsMapEngine.Loaded ref = RadiomicsMapEngine.readSlice(raw, "raw", codec);
                float[] expected = pixels(ref);
                assertFalse(ref.lossy());
                if (signed) {
                    assertTrue(min(expected) < -900, "負の値を含む（符号の扱いを試す）");
                }
                for (String ts : List.of(UID.JPEGLosslessSV1, UID.JPEGLSLossless, UID.JPEG2000Lossless)) {
                    Path c = transcode(raw, dir.resolve(ts + "-" + signed + z + ".dcm"), ts);
                    assertEquals(ts, transferSyntax(c), "本当に圧縮した");
                    RadiomicsMapEngine.Loaded got = RadiomicsMapEngine.readSlice(c, ts, codec);
                    assertArrayEquals(expected, pixels(got), UID.nameOf(ts) + " signed=" + signed);
                    assertFalse(got.lossy(), UID.nameOf(ts));
                }
                Path rle = writeRle(dir.resolve("rle-" + signed + z + ".dcm"), ds);
                RadiomicsMapEngine.Loaded got = RadiomicsMapEngine.readSlice(rle, "rle", codec);
                assertArrayEquals(expected, pixels(got), "RLE signed=" + signed);
                assertFalse(got.lossy());
            }
        }
    }

    @Test
    void lossyCompressionIsReadAndFlagged(@TempDir Path dir) throws Exception {
        PixelCodec codec = codec();
        Assumptions.assumeTrue(codec.available(), () -> "OpenCV ネイティブが無い: " + codec.unavailableReason());
        // 符号なし 12 bit にする。dcm4che の JPEG-LS Near-Lossless は、符号付き 16 bit では誤差 0 の符号を書いた
        // （dcm2dcm でも同じ。転送構文は Near-Lossless なので警告は付く）
        Path raw = write(dir, "raw.dcm", phantom(false, 0), UID.ExplicitVRLittleEndian);
        float[] expected = pixels(RadiomicsMapEngine.readSlice(raw, "raw", codec));
        for (String ts : List.of(UID.JPEGLSNearLossless, UID.JPEG2000)) {
            Path c = transcode(raw, dir.resolve(ts + ".dcm"), ts);
            assertEquals(ts, transferSyntax(c));
            RadiomicsMapEngine.Loaded got = RadiomicsMapEngine.readSlice(c, ts, codec);
            assertTrue(got.lossy(), UID.nameOf(ts));
            assertEquals(expected.length, pixels(got).length);
            assertFalse(java.util.Arrays.equals(expected, pixels(got)),
                    UID.nameOf(ts) + " は値が変わる（非可逆の試験になっている）");
        }
    }

    @Test
    void lossyImageCompressionAttributeAloneIsFlagged(@TempDir Path dir) throws Exception {
        PixelCodec codec = codec();
        Attributes ds = phantom(false, 0);
        assertFalse(RadiomicsMapEngine.readSlice(write(dir, "a.dcm", ds, UID.ExplicitVRLittleEndian), "a", codec).lossy());
        ds.setString(Tag.LossyImageCompression, VR.CS, "01");
        assertTrue(RadiomicsMapEngine.readSlice(write(dir, "b.dcm", ds, UID.ExplicitVRLittleEndian), "b", codec).lossy());
        ds.setString(Tag.LossyImageCompression, VR.CS, "00");
        assertFalse(RadiomicsMapEngine.readSlice(write(dir, "c.dcm", ds, UID.ExplicitVRLittleEndian), "c", codec).lossy());
    }

    @Test
    void missingNativeStopsWithTheReason(@TempDir Path dir) throws Exception {
        PixelCodec none = new PixelCodec(new DicomProperties()) {
            @Override
            public synchronized boolean available() {
                return false;
            }

            @Override
            public synchronized String unavailableReason() {
                return "試験用の理由";
            }
        };
        Attributes ds = phantom(true, 0);
        Path rle = writeRle(dir.resolve("rle.dcm"), ds);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> RadiomicsMapEngine.readSlice(rle, "rle", none));
        assertTrue(e.getMessage().contains("圧縮画像の伸長に必要な部品がありません（試験用の理由）"), e.getMessage());
        // 非圧縮は部品なしでも読める
        Path raw = write(dir, "raw.dcm", ds, UID.ExplicitVRLittleEndian);
        assertNotNull(RadiomicsMapEngine.readSlice(raw, "raw", none));
    }

    @Test
    void colorIsRejectedWithAClearReason(@TempDir Path dir) throws Exception {
        Attributes rgb = phantom(false, 0);
        rgb.setInt(Tag.SamplesPerPixel, VR.US, 3);
        rgb.setString(Tag.PhotometricInterpretation, VR.CS, "RGB");
        rgb.setInt(Tag.BitsAllocated, VR.US, 8);
        rgb.setInt(Tag.BitsStored, VR.US, 8);
        rgb.setInt(Tag.HighBit, VR.US, 7);
        rgb.setInt(Tag.PlanarConfiguration, VR.US, 0);
        rgb.setBytes(Tag.PixelData, VR.OB, new byte[W * H * 3]);
        Path raw = write(dir, "rgb.dcm", rgb, UID.ExplicitVRLittleEndian);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> RadiomicsMapEngine.readSlice(raw, "rgb", codec()));
        assertTrue(e.getMessage().contains("カラー画像") && e.getMessage().contains("対象外"), e.getMessage());

        // 圧縮のカラーも、伸長の部品の有無より先に「カラー」で断る
        Path rle = writeRle(dir.resolve("rgb-rle.dcm"), rgb);
        PixelCodec none = new PixelCodec(new DicomProperties()) {
            @Override
            public synchronized boolean available() {
                return false;
            }
        };
        IllegalArgumentException e2 = assertThrows(IllegalArgumentException.class,
                () -> RadiomicsMapEngine.readSlice(rle, "rgb-rle", none));
        assertTrue(e2.getMessage().contains("カラー画像"), e2.getMessage());
    }

    @Test
    void derivedSeriesRecordsLossySource() {
        TextureSeriesRequest req = new TextureSeriesRequest("1.2", "1.2.9", "1.2.8", 0, "GLCM_JointEntropy", 5, 1,
                false, 0, 0, java.util.Map.of(), null, null, null);
        assertTrue(TextureSeriesService.derivationDescription(req, "GLCM_JointEntropy", true)
                .endsWith(", source: lossy compressed)"));
        assertFalse(TextureSeriesService.derivationDescription(req, "GLCM_JointEntropy", false).contains("lossy"));
    }

    @Test
    void transferSyntaxLossinessTable() {
        for (String ts : List.of(UID.JPEGBaseline8Bit, UID.JPEGExtended12Bit, UID.JPEGLSNearLossless,
                UID.JPEG2000, UID.HTJ2K, UID.JPEGXL)) {
            assertTrue(RadiomicsMapEngine.isLossy(new Attributes(), ts), UID.nameOf(ts));
        }
        for (String ts : List.of(UID.ExplicitVRLittleEndian, UID.JPEGLosslessSV1, UID.JPEGLSLossless,
                UID.JPEG2000Lossless, UID.RLELossless)) {
            assertFalse(RadiomicsMapEngine.isLossy(new Attributes(), ts), UID.nameOf(ts));
        }
    }

    private static float min(float[] a) {
        float m = Float.POSITIVE_INFINITY;
        for (float v : a) m = Math.min(m, v);
        return m;
    }

    private static String transferSyntax(Path p) throws IOException {
        try (org.dcm4che3.io.DicomInputStream in = new org.dcm4che3.io.DicomInputStream(p.toFile())) {
            in.readFileMetaInformation();
            return in.getTransferSyntax();
        }
    }

    // --- RLE Lossless（PS3.5 Annex G）: 1 フレーム。バイト面ごとに PackBits で符号化する ---

    private static Path writeRle(Path dst, Attributes src) throws IOException {
        Attributes ds = new Attributes(src);
        byte[] px = src.getBytes(Tag.PixelData);
        int bytesPerSample = src.getInt(Tag.BitsAllocated, 16) / 8;
        int samples = src.getInt(Tag.SamplesPerPixel, 1);
        int n = W * H;
        // セグメントの並び: 標本ごとに、上位バイト面 → 下位バイト面（G.2）
        List<byte[]> segments = new java.util.ArrayList<>();
        for (int s = 0; s < samples; s++) {
            for (int b = bytesPerSample - 1; b >= 0; b--) {
                byte[] plane = new byte[n];
                for (int i = 0; i < n; i++) {
                    plane[i] = px[(i * samples + s) * bytesPerSample + b];
                }
                segments.add(packBits(plane));
            }
        }
        ByteArrayOutputStream frame = new ByteArrayOutputStream();
        byte[] header = new byte[64];
        putIntLE(header, 0, segments.size());
        int offset = 64;
        for (int i = 0; i < segments.size(); i++) {
            putIntLE(header, 4 + 4 * i, offset);
            offset += segments.get(i).length;
        }
        frame.write(header);
        for (byte[] seg : segments) frame.write(seg);
        if (frame.size() % 2 != 0) frame.write(0);

        ds.remove(Tag.PixelData);
        Fragments frags = ds.newFragments(Tag.PixelData, VR.OB, 2);
        frags.add(new byte[0]);
        frags.add(frame.toByteArray());
        try (OutputStream os = Files.newOutputStream(dst);
             DicomOutputStream out = new DicomOutputStream(os, UID.ExplicitVRLittleEndian)) {
            out.writeDataset(ds.createFileMetaInformation(UID.RLELossless), ds);
        }
        return dst;
    }

    /** PackBits: 同じ値が 3 個以上続けば繰り返し（-(n-1)）、それ以外は直値（n-1）。どちらも 128 個まで。 */
    private static byte[] packBits(byte[] in) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int i = 0;
        while (i < in.length) {
            int run = 1;
            while (i + run < in.length && run < 128 && in[i + run] == in[i]) run++;
            if (run >= 3) {
                out.write(-(run - 1));
                out.write(in[i]);
                i += run;
                continue;
            }
            int start = i;
            int lit = 0;
            while (i < in.length && lit < 128) {
                if (i + 2 < in.length && in[i] == in[i + 1] && in[i] == in[i + 2]) break;
                i++;
                lit++;
            }
            out.write(lit - 1);
            out.write(in, start, lit);
        }
        if (out.size() % 2 != 0) out.write(0x80); // 偶数長に揃える（-128 は何もしない符号）
        return out.toByteArray();
    }

    private static void putIntLE(byte[] b, int at, int v) {
        b[at] = (byte) v;
        b[at + 1] = (byte) (v >> 8);
        b[at + 2] = (byte) (v >> 16);
        b[at + 3] = (byte) (v >> 24);
    }
}
