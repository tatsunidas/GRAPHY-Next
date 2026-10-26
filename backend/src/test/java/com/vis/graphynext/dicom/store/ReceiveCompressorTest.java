/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.imageio.codec.Compressor;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 受信時の可逆圧縮。🔴 最大の検査は「すでに圧縮されたものを触らない（多重圧縮しない）」。
 *
 * <p>ネイティブ（OpenCV）が無い環境は飛ばす（{@code PixelCodecTest} と同じ）。
 */
class ReceiveCompressorTest {

    private static final int W = 96;
    private static final int H = 80;

    private PixelCodec codec;
    private SettingsService settings;
    private ReceiveCompressor rc;
    private volatile String mode;

    @BeforeEach
    void setUp() {
        codec = new PixelCodec(new DicomProperties());
        settings = mock(SettingsService.class);
        mode = ReceiveCompressor.MODE_JPEGLS;
        when(settings.getAll()).thenAnswer(i -> mode == null ? Map.<String, String>of() : Map.of(ReceiveCompressor.KEY, mode));
        rc = new ReceiveCompressor(settings, codec);
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
    }

    // ---- 正例 ----

    @Test
    void 非圧縮のCTはJPEGLS可逆になり_小さく_画素は一致_他の属性は不変(@TempDir Path dir) throws Exception {
        Path f = writeRaw(dir.resolve("a"), UID.CTImageStorage, 16, true, "MONOCHROME2");
        byte[] want = pixelsOf(f);
        long before = Files.size(f);
        Attributes hdr = header(f);

        Path out = rc.process(f);

        assertNotEquals(f, out, "新しいファイルを返す");
        assertFalse(Files.exists(f), "元の一時ファイルは消える");
        assertEquals(UID.JPEGLSLossless, tsOf(out));
        assertTrue(Files.size(out) < before, "小さくなる");
        assertArrayEquals(want, decodePixels(out), "復号した画素が元と 1 バイトまで一致");
        assertEquals(hdr, header(out), "SOP UID を含む他の属性は不変");
        ReceiveCompressor.Status st = rc.status();
        assertEquals(1, st.compressed());
        assertTrue(st.savedBytes() > 0);
    }

    @Test
    void 他の型_8bit_12bit格納符号なし_MRとCR(@TempDir Path dir) throws Exception {
        for (Object[] c : new Object[][] {
            {UID.MRImageStorage, 16, false, "MONOCHROME2"},
            {UID.ComputedRadiographyImageStorage, 8, false, "MONOCHROME1"},
            {UID.DigitalXRayImageStorageForPresentation, 16, false, "MONOCHROME2"}}) {
            Path f = writeRaw(dir.resolve("k" + c[0]), (String) c[0], (int) c[1], (boolean) c[2], (String) c[3]);
            byte[] want = pixelsOf(f);
            Path out = rc.process(f);
            assertEquals(UID.JPEGLSLossless, tsOf(out), c[0] + "");
            assertArrayEquals(want, decodePixels(out));
        }
    }

    // ---- 🔴 多重圧縮をしない ----

    @Test
    void すでに圧縮済みのものは同じパスのまま_バイト列も不変(@TempDir Path dir) throws Exception {
        for (String ts : new String[] {UID.JPEGLSLossless, UID.JPEG2000Lossless, UID.JPEGBaseline8Bit}) {
            boolean eightBit = UID.JPEGBaseline8Bit.equals(ts);
            Path f = writeCompressed(dir.resolve("c" + ts), UID.CTImageStorage, eightBit ? 8 : 16, ts);
            byte[] bytes = Files.readAllBytes(f);

            Path out = rc.process(f);

            assertEquals(f, out, "同じパスをそのまま返す: " + ts);
            assertArrayEquals(bytes, Files.readAllBytes(out), "1 バイトも変わらない（再符号化も復号もしない）: " + ts);
            assertEquals(ts, tsOf(out));
        }
        assertEquals(3, rc.status().skipped().get("already-compressed"));
        assertEquals(0, rc.status().compressed());
        assertEquals(0, rc.status().failed());
    }

    @Test
    void 圧縮した結果をもう一度通しても不変(@TempDir Path dir) throws Exception {
        Path f = writeRaw(dir.resolve("a"), UID.CTImageStorage, 16, true, "MONOCHROME2");
        Path once = rc.process(f);
        byte[] bytes = Files.readAllBytes(once);
        Path twice = rc.process(once);
        assertEquals(once, twice);
        assertArrayEquals(bytes, Files.readAllBytes(twice));
        assertEquals(1, rc.status().compressed(), "圧縮は 1 回だけ数える");
    }

    // ---- 負例 ----

    @Test
    void 設定がオフ_キー無し_不正値ならそのまま(@TempDir Path dir) throws Exception {
        for (String m : new String[] {"off", null, "bogus", ""}) {
            mode = m;
            Path f = writeRaw(dir.resolve("o" + m), UID.CTImageStorage, 16, true, "MONOCHROME2");
            byte[] bytes = Files.readAllBytes(f);
            assertEquals(f, rc.process(f));
            assertArrayEquals(bytes, Files.readAllBytes(f));
        }
        assertEquals(0, rc.status().compressed());
    }

    @Test
    void 対象外のSOPクラス_カラー_はそのまま(@TempDir Path dir) throws Exception {
        for (Object[] c : new Object[][] {
            {UID.EnhancedCTImageStorage, "MONOCHROME2"},
            {UID.SegmentationStorage, "MONOCHROME2"},
            {UID.UltrasoundImageStorage, "MONOCHROME2"},
            {UID.CTImageStorage, "RGB"}}) {
            Path f = writeRaw(dir.resolve("n" + c[0] + c[1]), (String) c[0], 16, false, (String) c[1]);
            byte[] bytes = Files.readAllBytes(f);
            assertEquals(f, rc.process(f), c[0] + "/" + c[1]);
            assertArrayEquals(bytes, Files.readAllBytes(f));
        }
        assertEquals(0, rc.status().compressed());
    }

    @Test
    void 壊れた符号化は検出して元のまま保存_受信は失敗させない(@TempDir Path dir) throws Exception {
        Path f = writeRaw(dir.resolve("a"), UID.CTImageStorage, 16, true, "MONOCHROME2");
        byte[] bytes = Files.readAllBytes(f);
        rc.setAfterEncodeForTest(out -> {
            try {
                byte[] all = Files.readAllBytes(out);
                for (int i = all.length / 2; i < all.length - 16; i += 61) {
                    all[i] = (byte) ~all[i];
                }
                Files.write(out, all);
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });
        Path out = rc.process(f);
        assertEquals(f, out, "元のまま返す");
        assertArrayEquals(bytes, Files.readAllBytes(f), "元のファイルは無傷");
        assertFalse(Files.exists(dir.resolve("a.lz")), "壊れた出力は残さない");
        assertEquals(1, rc.status().failed());
        assertEquals(0, rc.status().compressed());
    }

    @Test
    void 小さくならない画素は元のまま(@TempDir Path dir) throws Exception {
        Path f = writeRawNoise(dir.resolve("noise"));
        byte[] bytes = Files.readAllBytes(f);
        assertEquals(f, rc.process(f));
        assertArrayEquals(bytes, Files.readAllBytes(f));
        assertEquals(1, rc.status().skipped().get("not-smaller"), "小さくならないので見送った（失敗ではない）");
        assertEquals(0, rc.status().failed());
        assertEquals(0, rc.status().compressed());
    }

    @Test
    void 並行して呼んでも全件一致(@TempDir Path dir) throws Exception {
        ExecutorService ex = Executors.newFixedThreadPool(4);
        try {
            List<Future<Boolean>> fs = new ArrayList<>();
            for (int i = 0; i < 12; i++) {
                final int n = i;
                fs.add(ex.submit(() -> {
                    Path f = writeRaw(dir.resolve("p" + n), UID.CTImageStorage, 16, true, "MONOCHROME2", n);
                    byte[] want = pixelsOf(f);
                    Path out = rc.process(f);
                    return UID.JPEGLSLossless.equals(tsOf(out)) && java.util.Arrays.equals(want, decodePixels(out));
                }));
            }
            for (Future<Boolean> f : fs) {
                assertTrue(f.get(), "並行でも可逆");
            }
        } finally {
            ex.shutdownNow();
        }
        assertEquals(12, rc.status().compressed());
        assertEquals(0, rc.status().failed());
    }

    // ---- 部品 ----

    private Attributes dataset(String cuid, int bits, boolean signed, String photometric, int seed) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, cuid);
        ds.setString(Tag.SOPInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.1." + seed);
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.2");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.3");
        ds.setString(Tag.PatientID, VR.LO, "RCOMP");
        ds.setString(Tag.Modality, VR.CS, "CT");
        ds.setString(Tag.PhotometricInterpretation, VR.CS, photometric);
        boolean rgb = "RGB".equals(photometric);
        ds.setInt(Tag.SamplesPerPixel, VR.US, rgb ? 3 : 1);
        ds.setInt(Tag.Rows, VR.US, H);
        ds.setInt(Tag.Columns, VR.US, W);
        ds.setInt(Tag.BitsAllocated, VR.US, bits);
        ds.setInt(Tag.BitsStored, VR.US, bits);
        ds.setInt(Tag.HighBit, VR.US, bits - 1);
        ds.setInt(Tag.PixelRepresentation, VR.US, signed ? 1 : 0);
        if (rgb) {
            ds.setInt(Tag.PlanarConfiguration, VR.US, 0);
        }
        int spp = rgb ? 3 : 1;
        ByteBuffer bb = ByteBuffer.allocate(W * H * spp * (bits / 8)).order(ByteOrder.LITTLE_ENDIAN);
        Random rnd = new Random(7 + seed);
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                for (int s = 0; s < spp; s++) {
                    double dx = (x - W / 2.0) / (W * 0.4);
                    double dy = (y - H / 2.0) / (H * 0.4);
                    boolean body = dx * dx + dy * dy < 1;
                    int v = body ? 100 + (y % 13) : 5;
                    v += rnd.nextInt(5) - 2;
                    if (bits == 8) {
                        bb.put((byte) Math.max(0, Math.min(255, v)));
                    } else {
                        bb.putShort((short) (signed ? v - 1000 : v));
                    }
                }
            }
        }
        ds.setBytes(Tag.PixelData, bits == 8 ? VR.OB : VR.OW, bb.array());
        return ds;
    }

    private Path writeRaw(Path f, String cuid, int bits, boolean signed, String photometric) throws IOException {
        return writeRaw(f, cuid, bits, signed, photometric, 1);
    }

    private Path writeRaw(Path f, String cuid, int bits, boolean signed, String photometric, int seed) throws IOException {
        write(f, dataset(cuid, bits, signed, photometric, seed), UID.ExplicitVRLittleEndian);
        return f;
    }

    private Path writeRawNoise(Path f) throws IOException {
        Attributes ds = dataset(UID.CTImageStorage, 16, true, "MONOCHROME2", 1);
        byte[] px = new byte[W * H * 2];
        new Random(1).nextBytes(px);
        ds.setBytes(Tag.PixelData, VR.OW, px);
        write(f, ds, UID.ExplicitVRLittleEndian);
        return f;
    }

    /** 圧縮済みの入力を、テスト側で用意する（受信側のコードは使わない）。 */
    private Path writeCompressed(Path f, String cuid, int bits, String ts) throws IOException {
        Path raw = f.resolveSibling(f.getFileName() + ".raw");
        write(raw, dataset(cuid, bits, bits == 16, "MONOCHROME2", 1), UID.ExplicitVRLittleEndian);
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(raw.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
        }
        try (Compressor c = new Compressor(ds, UID.ExplicitVRLittleEndian)) {
            assertTrue(c.compress(ts), "前提: 圧縮済み入力を作れる " + ts);
            write(f, ds, ts);
        }
        assertNotEquals(UID.ExplicitVRLittleEndian, tsOf(f));
        return f;
    }

    private static void write(Path f, Attributes ds, String ts) throws IOException {
        Attributes fmi = ds.createFileMetaInformation(ts);
        try (OutputStream os = Files.newOutputStream(f); DicomOutputStream dos = new DicomOutputStream(os, ts)) {
            dos.writeDataset(fmi, ds);
        }
    }

    private static String tsOf(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            Attributes fmi = in.readFileMetaInformation();
            assertNotNull(fmi);
            return fmi.getString(Tag.TransferSyntaxUID);
        }
    }

    private static Attributes header(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            return in.readDatasetUntilPixelData();
        }
    }

    private static byte[] pixelsOf(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            return in.readDataset(-1, -1).getBytes(Tag.PixelData);
        }
    }

    private byte[] decodePixels(Path f) throws IOException {
        Attributes ds;
        String ts;
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
            ts = in.getTransferSyntax();
        }
        return codec.decompress(ds, ts);
    }
}
