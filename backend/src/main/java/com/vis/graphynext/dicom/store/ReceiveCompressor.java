/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.BulkData;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.imageio.codec.Compressor;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * 受信した DICOM（C-STORE・C-GET）の画素を、保管庫・索引に入れる前に<b>可逆</b>圧縮する。
 *
 * <p>設定 {@value #KEY} が {@value #MODE_JPEGLS} のときだけ働く（既定は無効）。受信のたびに設定を読む。
 *
 * <h2>🔴 多重圧縮をしない</h2>
 * <ul>
 *   <li>入力の転送構文が非圧縮でなければ<b>復号も再符号化もせず</b>そのまま返す（すでに圧縮済みのものを触らない）。
 *       出力は必ず圧縮済みなので、同じ関数に 2 回通っても 2 回目は何もしない（冪等）。</li>
 *   <li>保管庫の既存ファイルは読まない。受信した一時ファイルだけを 1 回変換する。</li>
 *   <li>小さくならなければ元のまま返す。</li>
 * </ul>
 *
 * <h2>失敗は受信を失敗させない</h2>
 * 符号化できない・復号して元の画素と 1 バイトでも違う・ネイティブが使えない、は元の一時ファイルをそのまま返す
 * （画像は失われない）。記録には患者名・ID・UID を書かない。
 */
@Service
public class ReceiveCompressor {

    private static final Logger log = LoggerFactory.getLogger(ReceiveCompressor.class);

    public static final String KEY = "dicom.receiveCompress";
    public static final String MODE_JPEGLS = "jpegls";

    /** 画素の上限。これを超える画像は（全バイト比較のためのメモリを避けて）圧縮しない。 */
    static final long MAX_PIXEL_BYTES = 256L << 20;

    /** 読み手の対応が済むまでは、単純な単色の通常画像だけを対象にする（Enhanced・XA・US・カラー・SEG・SR などは対象外）。 */
    static final Set<String> TARGET_SOP_CLASSES = Set.of(
            UID.CTImageStorage,
            UID.MRImageStorage,
            UID.ComputedRadiographyImageStorage,
            UID.DigitalXRayImageStorageForPresentation,
            UID.DigitalXRayImageStorageForProcessing,
            UID.DigitalMammographyXRayImageStorageForPresentation,
            UID.DigitalMammographyXRayImageStorageForProcessing,
            UID.PositronEmissionTomographyImageStorage);

    /** 状態（画面・REST 用）。 */
    public record Status(String mode, boolean available, String unavailableReason, long compressed, long failed,
                         long savedBytes, Map<String, Long> skipped, String lastFailure) {
    }

    private final SettingsService settings;
    private final PixelCodec codec;
    private final AtomicLong compressed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong savedBytes = new AtomicLong();
    private final Map<String, AtomicLong> skipped = new ConcurrentHashMap<>();
    private volatile String lastFailure = "";

    /** テスト用: 符号化した直後のファイルに手を入れる（壊れた符号化を検出できるかの確認）。 */
    private volatile Consumer<Path> afterEncode;

    public ReceiveCompressor(SettingsService settings, PixelCodec codec) {
        this.settings = settings;
        this.codec = codec;
    }

    void setAfterEncodeForTest(Consumer<Path> hook) {
        this.afterEncode = hook;
    }

    public boolean enabled() {
        return MODE_JPEGLS.equals(settings.getAll().get(KEY));
    }

    public Status status() {
        Map<String, Long> sk = new TreeMap<>();
        skipped.forEach((k, v) -> sk.put(k, v.get()));
        boolean ok = codec.available();
        return new Status(enabled() ? MODE_JPEGLS : "off", ok, ok ? "" : codec.unavailableReason(),
                compressed.get(), failed.get(), savedBytes.get(), sk, lastFailure);
    }

    /**
     * 受信した一時ファイルを可逆圧縮して、新しい一時ファイルを返す（成功時は元の一時ファイルを消す）。
     * 無効・対象外・失敗のときは {@code temp} をそのまま返す。
     */
    public Path process(Path temp) {
        if (!enabled()) {
            return temp;
        }
        Path out = temp.resolveSibling(temp.getFileName() + ".lz");
        try {
            if (!codec.available()) {
                skip("native-unavailable");
                return temp;
            }
            Path result = compress(temp, out);
            if (result == null) {
                deleteQuietly(out);
                return temp;
            }
            long before = Files.size(temp);
            long after = Files.size(result);
            Files.delete(temp);
            compressed.incrementAndGet();
            savedBytes.addAndGet(before - after);
            return result;
        } catch (Exception e) {
            deleteQuietly(out);
            fail("exception " + e.getClass().getSimpleName() + ": " + e.getMessage());
            return temp;
        }
    }

    /** 対象外・失敗・不一致なら null（呼び出し元が元のまま返す）。 */
    private Path compress(Path temp, Path out) throws IOException {
        Attributes fmi;
        Attributes ds;
        String srcTs;
        try (DicomInputStream in = new DicomInputStream(temp.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            fmi = in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
            srcTs = in.getTransferSyntax();
        }
        // 🔴 多重圧縮の防止: 非圧縮でなければ何もしない（復号も再符号化もしない）
        if (!PixelCodec.isUncompressed(srcTs)) {
            skip("already-compressed");
            return null;
        }
        String reason = ineligible(fmi, ds);
        if (reason != null) {
            skip(reason);
            return null;
        }
        Object pv = ds.getValue(Tag.PixelData);
        if (!(pv instanceof BulkData bd) || bd.length() <= 0 || bd.length() > MAX_PIXEL_BYTES) {
            skip("pixel-size");
            return null;
        }
        byte[] want = ds.getBytes(Tag.PixelData);
        Attributes before = headerOf(temp);

        // 符号化は書き出しの最中に走る。Compressor は書き終えるまで閉じない。
        try (Compressor comp = new Compressor(ds, srcTs)) {
            if (!comp.compress(UID.JPEGLSLossless)) {
                fail("compress returned false");
                return null;
            }
            Attributes outFmi = new Attributes(fmi);
            outFmi.setString(Tag.TransferSyntaxUID, org.dcm4che3.data.VR.UI, UID.JPEGLSLossless);
            try (OutputStream os = Files.newOutputStream(out);
                    DicomOutputStream dos = new DicomOutputStream(os, UID.JPEGLSLossless)) {
                dos.writeDataset(outFmi, ds);
            }
        }
        Consumer<Path> hook = afterEncode;
        if (hook != null) {
            hook.accept(out);
        }
        if (Files.size(out) >= Files.size(temp)) {
            skip("not-smaller");
            return null;
        }
        // 復号して、元の画素と全バイト比較。他の属性が変わっていないことも見る。
        byte[] got = decode(out);
        if (got == null || !Arrays.equals(want, got)) {
            fail("pixel mismatch after encode");
            return null;
        }
        if (!before.equals(headerOf(out))) {
            fail("attributes changed by encode");
            return null;
        }
        return out;
    }

    private static String ineligible(Attributes fmi, Attributes ds) {
        String cuid = fmi != null && fmi.getString(Tag.MediaStorageSOPClassUID) != null
                ? fmi.getString(Tag.MediaStorageSOPClassUID) : ds.getString(Tag.SOPClassUID);
        if (cuid == null || !TARGET_SOP_CLASSES.contains(cuid)) {
            return "sop-class";
        }
        if (!ds.contains(Tag.PixelData)) {
            return "no-pixel";
        }
        if (ds.getInt(Tag.SamplesPerPixel, 1) != 1) {
            return "not-monochrome";
        }
        String pi = ds.getString(Tag.PhotometricInterpretation, "");
        if (!"MONOCHROME1".equals(pi) && !"MONOCHROME2".equals(pi)) {
            return "not-monochrome";
        }
        int bits = ds.getInt(Tag.BitsAllocated, 0);
        if (bits != 8 && bits != 16) {
            return "bits-allocated";
        }
        return null;
    }

    /** PixelData より前の属性（PixelData は圧縮で形が変わるので比べない）。 */
    private static Attributes headerOf(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            return in.readDatasetUntilPixelData();
        }
    }

    private byte[] decode(Path f) throws IOException {
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

    private void skip(String why) {
        skipped.computeIfAbsent(why, k -> new AtomicLong()).incrementAndGet();
    }

    private void fail(String why) {
        failed.incrementAndGet();
        lastFailure = why;
        log.warn("受信時の可逆圧縮をやめて元のまま保存します: {}", why);
    }

    private static void deleteQuietly(Path p) {
        try {
            Files.deleteIfExists(p);
        } catch (IOException ignore) {
            // ベストエフォート
        }
    }
}
