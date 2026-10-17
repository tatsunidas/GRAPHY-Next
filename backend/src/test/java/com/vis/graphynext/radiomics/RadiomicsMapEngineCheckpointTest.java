/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.cache.CacheStore;
import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/** スライス単位の途中結果: 再投入で続きから・結果は通しと一致・入力が変われば使わない。 */
class RadiomicsMapEngineCheckpointTest {

    private static final int W = 20, H = 20, D = 6, K = 5;

    private static ImagePlus phantom(int seed) {
        ImageStack st = new ImageStack(W, H);
        long s = 12345L + seed;
        for (int z = 0; z < D; z++) {
            FloatProcessor ip = new FloatProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                s = s * 6364136223846793005L + 1442695040888963407L;
                ip.setf(x, y, (int) Math.floorMod(s >> 33, 12) * 100f + z);
            }
            st.addSlice(ip);
        }
        ImagePlus imp = new ImagePlus("p", st);
        Calibration c = imp.getCalibration();
        c.pixelWidth = 1d; c.pixelHeight = 1d; c.pixelDepth = 1d;
        return imp;
    }

    private static ImagePlus mask() {
        ImageStack st = new ImageStack(W, H);
        for (int z = 0; z < D; z++) {
            ByteProcessor ip = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                ip.set(x, y, (x >= 4 && x < W - 4 && y >= 5 && y < H - 3 && z >= 1 && z < D - 1) ? 1 : 0);
            }
            st.addSlice(ip);
        }
        return new ImagePlus("m", st);
    }

    private static RadiomicsMapEngine.LoadedVolume volume(ImagePlus img) {
        String[] sops = new String[D];
        for (int z = 0; z < D; z++) sops[z] = "1.2.3." + z;
        return new RadiomicsMapEngine.LoadedVolume(img, mask(), W, H, D, 1, true, img.getCalibration(),
                null, 1d, 1d, new HashMap<>(), sops, null, null);
    }

    private static TextureSeriesRequest req(String feature, int stride, boolean d2, Integer margin, String desc) {
        Map<String, String> settings = new HashMap<>();
        settings.put("MASK_LABEL_INT", "1");
        return new TextureSeriesRequest("1.2", "1.2.9", "1.2.8", 0, feature, K, stride, d2, 0, 0,
                settings, margin, desc, null);
    }

    private static RadiomicsMapEngine engine(Path dir) {
        return new RadiomicsMapEngine(null, new MapCheckpointStore(new CacheStore(dir, 0), "2.4.0-test"));
    }

    private static long files(Path dir) throws Exception {
        if (!Files.isDirectory(dir)) return 0;
        try (Stream<Path> s = Files.list(dir)) { return s.filter(p -> p.toString().endsWith(".ckpt")).count(); }
    }

    private static void assertSame(float[][] a, float[][] b) {
        assertEquals(a.length, b.length);
        for (int z = 0; z < a.length; z++) {
            assertEquals(a[z].length, b[z].length);
            for (int i = 0; i < a[z].length; i++) {
                assertEquals(Float.floatToIntBits(a[z][i]), Float.floatToIntBits(b[z][i]), "z=" + z + " i=" + i);
            }
        }
    }

    private static final class StopAfter extends RuntimeException { }

    /** n 枚終わって保存したところで打ち切る（キャンセルと同じ経路）。 */
    private static TextureProgress stopAfter(int n) {
        return (done, total) -> { if (done >= n) throw new StopAfter(); };
    }

    @Test
    void resumesFromCheckpoints_andMatchesAFullRun(@TempDir Path dir) throws Exception {
        for (int stride : new int[] {1, 3}) {
            Path a = dir.resolve("a" + stride), b = dir.resolve("b" + stride);
            TextureSeriesRequest r = req("GLCM_JointEntropy", stride, false, 0, null);
            ImagePlus img = phantom(0);

            RadiomicsMapEngine.Computed full = engine(a).computeFrom(r, TextureProgress.NONE, volume(img));
            assertEquals(0, full.restoredSlices());

            RadiomicsMapEngine eng = engine(b);
            assertThrows(StopAfter.class, () -> eng.computeFrom(r, stopAfter(3), volume(img)));
            assertEquals(3, files(b), "打ち切るまでに終わった 3 枚が保存されている");

            RadiomicsMapEngine.Computed resumed = eng.computeFrom(r, TextureProgress.NONE, volume(img));
            assertEquals(3, resumed.restoredSlices(), "続きから: 3 枚は復元し、残りを計算する");
            assertSame(full.map().data(), resumed.map().data());
        }
    }

    @Test
    void discardRemovesCheckpoints(@TempDir Path dir) throws Exception {
        RadiomicsMapEngine eng = engine(dir);
        RadiomicsMapEngine.Computed c = eng.computeFrom(req("GLCM_JointEntropy", 1, false, 0, null),
                TextureProgress.NONE, volume(phantom(0)));
        assertEquals(D, files(dir));
        eng.discardCheckpoints(c);
        assertEquals(0, files(dir));
    }

    @Test
    void changedPixelsOrParametersDoNotReuse(@TempDir Path dir) throws Exception {
        RadiomicsMapEngine eng = engine(dir);
        TextureSeriesRequest r = req("GLCM_JointEntropy", 1, false, 0, null);
        eng.computeFrom(r, TextureProgress.NONE, volume(phantom(0)));

        assertEquals(0, eng.computeFrom(r, TextureProgress.NONE, volume(phantom(1))).restoredSlices(), "画素が違う");
        assertEquals(0, eng.computeFrom(req("GLCM_JointEntropy", 1, false, 3, null), TextureProgress.NONE,
                volume(phantom(0))).restoredSlices(), "margin が違う");
        assertEquals(0, eng.computeFrom(req("GLCM_JointEntropy", 1, true, 0, null), TextureProgress.NONE,
                volume(phantom(0))).restoredSlices(), "2D/3D が違う");
        assertEquals(0, eng.computeFrom(req("GLRLM_RunEntropy", 1, false, 0, null), TextureProgress.NONE,
                volume(phantom(0))).restoredSlices(), "特徴が違う");
    }

    @Test
    void outputOnlyFieldsDoNotChangeTheKey(@TempDir Path dir) throws Exception {
        RadiomicsMapEngine eng = engine(dir);
        eng.computeFrom(req("GLCM_JointEntropy", 1, false, 0, "one"), TextureProgress.NONE, volume(phantom(0)));
        RadiomicsMapEngine.Computed again = eng.computeFrom(req("GLCM_JointEntropy", 1, false, 0, "two"),
                TextureProgress.NONE, volume(phantom(0)));
        assertEquals(D, again.restoredSlices(), "シリーズ説明だけの違いでは全枚を復元する");
    }

    @Test
    void corruptedCheckpointFallsBackToRecomputation(@TempDir Path dir) throws Exception {
        RadiomicsMapEngine eng = engine(dir);
        TextureSeriesRequest r = req("GLCM_JointEntropy", 1, false, 0, null);
        RadiomicsMapEngine.Computed first = eng.computeFrom(r, TextureProgress.NONE, volume(phantom(0)));
        try (Stream<Path> s = Files.list(dir)) {
            Path victim = s.filter(p -> p.toString().endsWith("000002.ckpt")).findFirst().orElseThrow();
            byte[] raw = Files.readAllBytes(victim);
            raw[raw.length - 1] ^= 0x55;
            raw[0] ^= 0x55; // ヘッダも壊す
            Files.write(victim, raw);
        }
        RadiomicsMapEngine.Computed second = eng.computeFrom(r, TextureProgress.NONE, volume(phantom(0)));
        assertEquals(D - 1, second.restoredSlices(), "壊れた 1 枚だけ再計算する");
        assertSame(first.map().data(), second.map().data());
    }

    @Test
    void withoutKnownRadiomicsjVersionNothingIsReused(@TempDir Path dir) throws Exception {
        RadiomicsMapEngine eng = new RadiomicsMapEngine(null, new MapCheckpointStore(new CacheStore(dir, 0), null));
        TextureSeriesRequest r = req("GLCM_JointEntropy", 1, false, 0, null);
        eng.computeFrom(r, TextureProgress.NONE, volume(phantom(0)));
        assertEquals(0, files(dir), "版が分からなければ保存しない");
        assertEquals(0, eng.computeFrom(r, TextureProgress.NONE, volume(phantom(0))).restoredSlices());
    }

    @Test
    void detectsTheBundledRadiomicsjVersion() {
        assertNotNull(MapCheckpointStore.detectRadiomicsjVersion(), "同梱の RadiomicsJ の版が取れる");
    }
}
