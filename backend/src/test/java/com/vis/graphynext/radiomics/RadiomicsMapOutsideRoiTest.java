/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.cache.CacheStore;
import ij.ImagePlus;
import ij.ImageStack;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * マスクつきのマップは、ROI の外を実値 0.0 でなく値なし（NaN）にする。ROI の内側の値は変えない。
 * 「変更前」の出力は、同じ画像・同じマスクで {@code hasMask=false}（NaN を付けない経路）として得る。
 */
class RadiomicsMapOutsideRoiTest {

    private static final int W = 20, H = 20, D = 6, K = 5;

    private static ImagePlus phantom() {
        ImageStack st = new ImageStack(W, H);
        long s = 777L;
        for (int z = 0; z < D; z++) {
            FloatProcessor ip = new FloatProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                s = s * 6364136223846793005L + 1442695040888963407L;
                ip.setf(x, y, (int) Math.floorMod(s >> 33, 12) * 100f + z);
            }
            st.addSlice(ip);
        }
        ImagePlus imp = new ImagePlus("p", st);
        imp.getCalibration().pixelWidth = 1d;
        imp.getCalibration().pixelHeight = 1d;
        imp.getCalibration().pixelDepth = 1d;
        return imp;
    }

    private static boolean inRoi(int x, int y, int z) {
        return x >= 4 && x < W - 4 && y >= 5 && y < H - 3 && z >= 1 && z < D - 1;
    }

    /** ROI の内は label（3）、外は 0。 */
    private static ImagePlus mask(int label) {
        ImageStack st = new ImageStack(W, H);
        for (int z = 0; z < D; z++) {
            ByteProcessor ip = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                ip.set(x, y, inRoi(x, y, z) ? label : 0);
            }
            st.addSlice(ip);
        }
        return new ImagePlus("m", st);
    }

    private static RadiomicsMapEngine.LoadedVolume volume(boolean hasMask, TextureResampling.Grid grid) {
        ImagePlus img = phantom();
        String[] sops = new String[D];
        for (int z = 0; z < D; z++) sops[z] = "1.2.3." + z;
        return new RadiomicsMapEngine.LoadedVolume(img, mask(3), W, H, D, 3, hasMask, img.getCalibration(),
                null, 1d, 1d, new HashMap<>(), sops, null, grid, false);
    }

    private static TextureSeriesRequest req(int stride) {
        Map<String, String> settings = new HashMap<>();
        settings.put("MASK_LABEL_INT", "3");
        return new TextureSeriesRequest("1.2", "1.2.9", "1.2.8", 0, "GLCM_JointEntropy", K, stride, false, 0, 0,
                settings, 0, null, null);
    }

    private static RadiomicsMapEngine engine(Path dir) {
        return new RadiomicsMapEngine(null, new MapCheckpointStore(new CacheStore(dir, 0), "2.4.0-test"), null);
    }

    private static float[][] run(Path dir, int stride, boolean hasMask, TextureResampling.Grid grid) {
        return engine(dir).computeFrom(req(stride), TextureProgress.NONE, volume(hasMask, grid)).map().data();
    }

    @Test
    void stride1_outsideIsNaN_insideIsUnchanged(@TempDir Path dir) {
        float[][] old = run(dir.resolve("old"), 1, false, null);
        float[][] now = run(dir.resolve("new"), 1, true, null);
        int in = 0, out = 0;
        for (int z = 0; z < D; z++) for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
            int i = y * W + x;
            if (inRoi(x, y, z)) {
                assertEquals(old[z][i], now[z][i], 0f, "ROI の内側は変更前と同一 (" + x + "," + y + "," + z + ")");
                assertFalse(Float.isNaN(now[z][i]));
                in++;
            } else {
                assertEquals(0f, old[z][i], 0f, "前提: 変更前は ROI の外に 0.0 を書いていた");
                assertTrue(Float.isNaN(now[z][i]), "ROI の外は値なし (" + x + "," + y + "," + z + ")");
                out++;
            }
        }
        assertTrue(in > 0 && out > 0);
    }

    @Test
    void stride2_outsideIsNaN_insideIsUnchanged(@TempDir Path dir) {
        float[][] old = run(dir.resolve("old"), 2, false, null);
        float[][] now = run(dir.resolve("new"), 2, true, null);
        int in = 0;
        for (int z = 0; z < D; z++) for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
            int i = y * W + x;
            if (inRoi(x, y, z)) {
                assertEquals(old[z][i], now[z][i], 0f, "(" + x + "," + y + "," + z + ")");
                in++;
            } else {
                assertTrue(Float.isNaN(now[z][i]), "(" + x + "," + y + "," + z + ")");
            }
        }
        assertTrue(in > 0);
    }

    @Test
    void noMask_everyPixelIsIdenticalToBefore(@TempDir Path dir) {
        // hasMask=false が「変更前」の経路そのもの。NaN が 1 つも入らないことと、再実行で同一なことを見る。
        float[][] a = run(dir.resolve("a"), 1, false, null);
        float[][] b = run(dir.resolve("b"), 1, false, null);
        for (int z = 0; z < D; z++) {
            assertArrayEquals(a[z], b[z]);
            for (float v : a[z]) assertFalse(Float.isNaN(v));
        }
    }

    @Test
    void resampled_outsideIsNaN_byNearestMaskCell_insideInterpolationUnchanged(@TempDir Path dir) {
        // 計算格子 20x20x6（1mm）→ 出力格子 10x10x3（2mm）
        TextureResampling.Grid g = TextureResampling.Grid.of(10, 10, 3, W, H, D,
                new double[]{2, 2, 2}, new double[]{1, 1, 1});
        float[][] old = run(dir.resolve("old"), 1, false, g);
        float[][] now = run(dir.resolve("new"), 1, true, g);
        boolean[][] in = new boolean[D][W * H];
        for (int z = 0; z < D; z++) for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) in[z][y * W + x] = inRoi(x, y, z);
        boolean[][] expect = TextureResampling.insideOnSourceGrid(in, W, H, D, g);
        int inside = 0, outside = 0;
        for (int z = 0; z < 3; z++) for (int i = 0; i < 100; i++) {
            if (expect[z][i]) {
                assertEquals(old[z][i], now[z][i], 0f, "ROI の内側の補間は変えない");
                assertFalse(Float.isNaN(now[z][i]));
                inside++;
            } else {
                assertTrue(Float.isNaN(now[z][i]));
                outside++;
            }
        }
        assertTrue(inside > 0 && outside > 0);
    }

    @Test
    void nearestInsideMapsByRoundedSourceCoordinate() {
        // 計算格子 4x1x1、出力格子 2x1x1（scale=2, origin は Utils.gridOrigin）。
        TextureResampling.Grid g = new TextureResampling.Grid(2, 1, 1, 2.0, 1.0, 1.0, 0.25, 0, 0,
                new double[]{2, 1, 1}, new double[]{1, 1, 1});
        // x=0 → fx=(0-0.25)*2=-0.5 → 四捨五入で 0、x=1 → fx=1.5 → 四捨五入で 2（1 ではない）。
        boolean[][] in = {{false, true, false, false}};
        boolean[][] out = TextureResampling.insideOnSourceGrid(in, 4, 1, 1, g);
        assertFalse(out[0][0]);
        assertFalse(out[0][1], "1.5 は 2 へ丸まる（in[1] は true だが使われない）");
        boolean[][] in2 = {{false, false, true, false}};
        assertTrue(TextureResampling.insideOnSourceGrid(in2, 4, 1, 1, g)[0][1]);
    }

    @Test
    void minMaxAndQuantizationIgnoreOutsideRoi(@TempDir Path dir) {
        float[][] old = run(dir.resolve("old"), 1, false, null);
        float[][] now = run(dir.resolve("new"), 1, true, null);
        double roiMin = Double.POSITIVE_INFINITY, roiMax = Double.NEGATIVE_INFINITY;
        for (int z = 0; z < D; z++) for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
            if (!inRoi(x, y, z)) continue;
            double v = old[z][y * W + x];
            roiMin = Math.min(roiMin, v);
            roiMax = Math.max(roiMax, v);
        }
        assertTrue(roiMin > 0, "前提: ROI 内の最小は 0 より大きい（0 に引きずられると最小が変わる）");
        // 変更前: ROI の外の 0 が最小になる
        assertEquals(0.0, TextureSeriesService.minMax(old)[0], 0.0);
        double[] mm = TextureSeriesService.minMax(now);
        assertEquals(roiMin, mm[0], 0.0);
        assertEquals(roiMax, mm[1], 0.0);
        double[] q = TextureSeriesService.quantization(mm);
        // ROI 内の最小は画素 1、外は画素 0（値なし）
        for (int z = 0; z < D; z++) {
            byte[] px = TextureSeriesService.to16bit(now[z], q[2], q[3]);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                int i = y * W + x;
                int p = (px[i * 2] & 0xFF) | ((px[i * 2 + 1] & 0xFF) << 8);
                if (inRoi(x, y, z)) {
                    assertTrue(p >= 1);
                    if (old[z][i] == roiMin) assertEquals(1, p);
                } else {
                    assertEquals(0, p);
                }
            }
        }
    }
}
