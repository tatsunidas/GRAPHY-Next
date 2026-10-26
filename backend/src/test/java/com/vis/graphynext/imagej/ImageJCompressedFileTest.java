/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.imagej;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.CompressedFixtures;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * ImageJ 連携: 圧縮（JPEG-LS 可逆）で保管したファイルも、非圧縮と同じ画素・同じ校正で開ける。
 * ImageJ の DICOM 読み込みは圧縮画素を知らないので、復号した一時ファイルで開く。
 */
class ImageJCompressedFileTest {

    private static short[] pixels(ImageJBridgeService.Loaded l) {
        return (short[]) l.ip().convertToShort(false).getPixels();
    }

    @Test
    void 圧縮ファイルは非圧縮と同じ画素と校正で開ける_一時ファイルは残らない(@TempDir Path dir) throws Exception {
        PixelCodec codec = new PixelCodec(new DicomProperties());
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
        Attributes ds = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7201", "IJPID");
        Path raw = dir.resolve("raw.dcm");
        CompressedFixtures.write(raw, ds, UID.ExplicitVRLittleEndian);
        Path comp = CompressedFixtures.compressed(dir.resolve("comp.dcm"), ds, UID.JPEGLSLossless);
        ImageJBridgeService svc = new ImageJBridgeService(null, codec);

        long tmpBefore = countTemp();
        ImageJBridgeService.Loaded base = svc.openProcessor(raw, 0);
        ImageJBridgeService.Loaded got = svc.openProcessor(comp, 0);

        assertNotNull(base, "前提: 非圧縮は開ける");
        assertNotNull(got, "圧縮ファイルが開ける");
        assertArrayEquals(pixels(base), pixels(got), "画素が非圧縮と一致");
        assertEquals(base.cal().getCValue(0), got.cal().getCValue(0), 0.0, "校正（HU）が一致");
        assertEquals(tmpBefore, countTemp(), "復号した一時ファイルが残らない");
        // 検出器の確認: 画素を 1 つ変えると一致しない
        short[] changed = pixels(got).clone();
        changed[0] += 1;
        org.junit.jupiter.api.Assertions.assertFalse(java.util.Arrays.equals(pixels(base), changed));
        assertEquals(ds.getInt(Tag.Rows, 0), got.ip().getHeight());
    }

    @Test
    void 復号できない環境では黙って壊れた画像を出さず_nullを返す(@TempDir Path dir) throws Exception {
        PixelCodec real = new PixelCodec(new DicomProperties());
        Assumptions.assumeTrue(real.available(), "圧縮ファイルの作成にネイティブが要る");
        Attributes ds = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7202", "IJPID");
        Path comp = CompressedFixtures.compressed(dir.resolve("comp.dcm"), ds, UID.JPEGLSLossless);
        PixelCodec unavailable = new PixelCodec(new DicomProperties()) {
            @Override
            public synchronized boolean available() {
                return false;
            }
        };
        assertNull(new ImageJBridgeService(null, unavailable).openProcessor(comp, 0));
    }

    private static long countTemp() throws Exception {
        try (Stream<Path> s = Files.list(Path.of(System.getProperty("java.io.tmpdir")))) {
            return s.filter(p -> p.getFileName().toString().startsWith("graphy-unc-")).count();
        }
    }
}
