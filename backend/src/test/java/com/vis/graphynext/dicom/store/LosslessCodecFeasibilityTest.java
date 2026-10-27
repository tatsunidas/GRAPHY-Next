/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.DicomProperties;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.imageio.codec.Compressor;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
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
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 可逆圧縮（JPEG-LS／JPEG 2000／RLE の Lossless）への符号化が、この OS で使えて、
 * 復号した画素が元と**1 バイトも違わない**かを実測する（実現性の調査）。製品コードは使わない。
 *
 * <p>結果は {@code target/lossless-feasibility.json} と標準出力の表に残す。符号化できない組み合わせは
 * 「未対応」として<b>記録するだけ</b>で落とさない（調べたいのはまさにそこ）。落とすのは次の 2 つだけ:
 * 符号化できたのに復号が元と違う（可逆でない）、検出器（壊れた符号化を見抜く）が空振り。
 *
 * <p>ネイティブ（OpenCV）や {@code --add-opens} が無い環境は飛ばす。ただし環境変数
 * {@code GRAPHY_REQUIRE_NATIVE_CODEC=1} のときは飛ばさず落とす（Actions で黙って未実行にしない）。
 */
class LosslessCodecFeasibilityTest {

    private static final int W = 128;
    private static final int H = 96;
    private static final int FRAMES = 3;

    private static final String[] TS = {UID.JPEGLSLossless, UID.JPEG2000Lossless, UID.RLELossless};
    private static final List<String> LOG = new ArrayList<>();

    /** 型の組み合わせ（名前, bitsAllocated, bitsStored, 符号付き, フレーム数）。 */
    private record Kind(String name, int alloc, int stored, boolean signed, int frames) {}

    private static final Kind[] KINDS = {
        new Kind("16bit符号付き(CT)", 16, 16, true, 1),
        new Kind("16bit符号なし12bit格納", 16, 12, false, 1),
        new Kind("8bit", 8, 8, false, 1),
        new Kind("16bit符号付き・複数フレーム", 16, 16, true, FRAMES),
    };

    private static PixelCodec codec() {
        return new PixelCodec(new DicomProperties());
    }

    private static boolean require() {
        return "1".equals(System.getenv("GRAPHY_REQUIRE_NATIVE_CODEC"));
    }

    private static void needNative(PixelCodec c) {
        if (c.available()) {
            return;
        }
        String why = "OpenCV ネイティブが使えない環境: " + c.unavailableReason();
        assertFalse(require(), "🔴 GRAPHY_REQUIRE_NATIVE_CODEC=1 なのにネイティブが使えない（黙って未実行にしない）: " + why);
        Assumptions.assumeTrue(false, why);
    }

    @Test
    void 可逆圧縮へ符号化して復号した画素が元と一致する(@TempDir Path dir) throws Exception {
        PixelCodec c = codec();
        needNative(c);
        int ran = 0;
        for (String ts : TS) {
            for (Kind k : KINDS) {
                String res;
                Attributes raw = phantom(k);
                byte[] want = raw.getSafeBytes(Tag.PixelData);
                long rawSize = want.length;
                Path f = dir.resolve(ts + "-" + k.name().hashCode() + ".dcm");
                long encSize = -1;
                try {
                    boolean ok;
                    Attributes src = asBulk(dir, raw, f.getFileName() + ".raw");
                    // 🔴 符号化は書き出し（DicomOutputStream）の最中に遅延して走る。Compressor は書き終えるまで閉じない
                    //    （先に close すると書き手が破棄され、書き出しで NullPointerException になる）。
                    try (Compressor comp = new Compressor(src, UID.ExplicitVRLittleEndian)) {
                        ok = comp.compress(ts);
                        if (ok) {
                            write(f, src, ts);
                        }
                    }
                    if (!ok) {
                        res = "未対応(compress が false)";
                    } else {
                        encSize = pixelFragmentsSize(f);
                        byte[] got = decode(c, f);
                        if (got == null) {
                            res = "復号できない";
                        } else if (java.util.Arrays.equals(want, got)) {
                            res = "一致";
                            ran++;
                        } else {
                            res = "不一致(可逆でない)";
                        }
                    }
                } catch (Throwable t) {
                    res = "未対応(" + t.getClass().getSimpleName() + ": " + String.valueOf(t.getMessage()).replaceAll("[\"\\n\\r]", " ") + ")";
                }
                LOG.add(row(ts, k, res, rawSize, encSize));
                assertFalse(res.startsWith("不一致"), "🔴 可逆でない: " + ts + " / " + k.name());
            }
        }
        System.out.println("[lossless-feasibility] os=" + System.getProperty("os.name") + "/" + System.getProperty("os.arch")
                + " 一致=" + ran + "/" + (TS.length * KINDS.length));
        if (require()) {
            assertTrue(ran > 0, "🔴 1 件も符号化・復号が通っていない（検査が空振り）");
        }
    }

    /**
     * 検出器の確認（負例）。符号化済みの画素を壊したら、復号が失敗するか画素が変わること。
     * これが通らないと、上の「一致」は何も保証しない。
     */
    @Test
    void 壊れた符号化は見抜ける(@TempDir Path dir) throws Exception {
        PixelCodec c = codec();
        needNative(c);
        int tried = 0;
        for (String ts : TS) {
            Kind k = KINDS[0];
            Attributes raw = phantom(k);
            byte[] want = raw.getSafeBytes(Tag.PixelData);
            Attributes src = asBulk(dir, raw, "neg-" + ts + ".raw");
            Path f = dir.resolve("neg-" + ts + ".dcm");
            try (Compressor comp = new Compressor(src, UID.ExplicitVRLittleEndian)) {
                if (!comp.compress(ts)) {
                    continue;
                }
                write(f, src, ts);
            } catch (Throwable t) {
                continue; // 符号化できない組み合わせは上のテストが記録する
            }
            assertTrue(java.util.Arrays.equals(want, decode(c, f)), "前提: 壊す前は一致する (" + ts + ")");
            corrupt(f);
            byte[] got = decode(c, f);
            assertTrue(got == null || !java.util.Arrays.equals(want, got), "🔴 壊れた符号化を見抜けない: " + ts);
            tried++;
        }
        if (require()) {
            assertTrue(tried > 0, "🔴 負例を 1 件も試せていない");
        }
    }

    @AfterAll
    static void report() throws IOException {
        if (LOG.isEmpty()) {
            return;
        }
        String json = "{\"os\":\"" + System.getProperty("os.name") + "\",\"arch\":\"" + System.getProperty("os.arch")
                + "\",\"java\":\"" + System.getProperty("java.version") + "\",\"cases\":[\n" + String.join(",\n", LOG) + "\n]}\n";
        Path out = Path.of("target", "lossless-feasibility.json");
        Files.createDirectories(out.getParent());
        Files.writeString(out, json);
        System.out.println(json);
    }

    // ---- 部品 ----

    private static String row(String ts, Kind k, String res, long raw, long enc) {
        String ratio = enc > 0 ? String.format(java.util.Locale.ROOT, "%.3f", (double) enc / raw) : "null";
        return "{\"ts\":\"" + ts + "\",\"kind\":\"" + k.name() + "\",\"result\":\"" + res + "\",\"rawBytes\":" + raw
                + ",\"encodedBytes\":" + enc + ",\"ratio\":" + ratio + "}";
    }

    /** 構造のある画素（楕円の体幹＋小さなノイズ）。完全乱数だと圧縮できず、小さくなることを確かめられない。 */
    private static Attributes phantom(Kind k) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.1");
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.2");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.826.0.1.3680043.10.1338.3");
        ds.setString(Tag.Modality, VR.CS, "CT");
        ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        ds.setInt(Tag.Rows, VR.US, H);
        ds.setInt(Tag.Columns, VR.US, W);
        ds.setInt(Tag.BitsAllocated, VR.US, k.alloc());
        ds.setInt(Tag.BitsStored, VR.US, k.stored());
        ds.setInt(Tag.HighBit, VR.US, k.stored() - 1);
        ds.setInt(Tag.PixelRepresentation, VR.US, k.signed() ? 1 : 0);
        if (k.frames() > 1) {
            ds.setInt(Tag.NumberOfFrames, VR.IS, k.frames());
        }
        int bytes = k.alloc() / 8;
        ByteBuffer bb = ByteBuffer.allocate(W * H * bytes * k.frames()).order(ByteOrder.LITTLE_ENDIAN);
        Random rnd = new Random(20261026L);
        int max = (1 << k.stored()) - 1;
        for (int fr = 0; fr < k.frames(); fr++) {
            for (int y = 0; y < H; y++) {
                for (int x = 0; x < W; x++) {
                    double dx = (x - W / 2.0) / (W * 0.40);
                    double dy = (y - H / 2.0) / (H * 0.40);
                    boolean body = dx * dx + dy * dy < 1.0;
                    int v;
                    if (k.alloc() == 8) {
                        v = (body ? 120 + (x * 60) / W : 8) + rnd.nextInt(5) - 2 + fr;
                    } else if (k.signed()) {
                        v = (body ? 40 + (y % 17) : -1000) + rnd.nextInt(11) - 5 + fr;
                    } else {
                        v = (body ? 1100 + (y % 23) : 40) + rnd.nextInt(9) - 4 + fr;
                    }
                    if (k.alloc() == 8) {
                        bb.put((byte) Math.max(0, Math.min(255, v)));
                    } else if (k.signed()) {
                        bb.putShort((short) v);
                    } else {
                        bb.putShort((short) Math.max(0, Math.min(max, v)));
                    }
                }
            }
        }
        ds.setBytes(Tag.PixelData, k.alloc() == 8 ? VR.OB : VR.OW, bb.array());
        return ds;
    }

    /**
     * 非圧縮のデータセットを一度ファイルへ書き、{@code IncludeBulkData.URI} で読み直す。
     * {@code Compressor}（Decompressor 系）は PixelData が {@code BulkData}（ファイルへの参照）であることを要求し、
     * byte[] のままだと ClassCastException になる（本番の受信経路は一時ファイルから読むので同じ形になる）。
     */
    private static Attributes asBulk(Path dir, Attributes raw, String name) throws IOException {
        Path f = dir.resolve(name);
        write(f, raw, UID.ExplicitVRLittleEndian);
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            return in.readDataset(-1, -1);
        }
    }

    private static void write(Path f, Attributes ds, String ts) throws IOException {
        Attributes fmi = ds.createFileMetaInformation(ts);
        try (OutputStream os = Files.newOutputStream(f); DicomOutputStream dos = new DicomOutputStream(os, ts)) {
            dos.writeDataset(fmi, ds);
        }
    }

    /** 本番の復号と同じ読み方（IncludeBulkData.URI → PixelCodec.decompress）。 */
    private static byte[] decode(PixelCodec c, Path f) throws IOException {
        Attributes ds;
        String ts;
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
            ts = in.getTransferSyntax();
        }
        return c.decompress(ds, ts);
    }

    private static long pixelFragmentsSize(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            Attributes ds = in.readDataset(-1, -1);
            Object v = ds.getValue(Tag.PixelData);
            long n = 0;
            if (v instanceof Fragments fr) {
                for (Object o : fr) {
                    if (o instanceof org.dcm4che3.data.BulkData bd) {
                        n += bd.length();
                    } else if (o instanceof byte[] b) {
                        n += b.length;
                    }
                }
            }
            return n;
        }
    }

    /** ファイル後半（PixelData の符号）の複数箇所を書き換える。1 バイトだけだと余白に当たることがある。 */
    private static void corrupt(Path f) throws IOException {
        byte[] all = Files.readAllBytes(f);
        int start = all.length / 2;
        for (int i = start; i < all.length - 16; i += 61) {
            all[i] = (byte) ~all[i];
        }
        Files.write(f, all);
    }
}
