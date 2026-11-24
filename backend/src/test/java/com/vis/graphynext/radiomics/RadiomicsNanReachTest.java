/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import static org.junit.jupiter.api.Assertions.*;

import com.vis.graphynext.cache.CacheStore;
import ij.ImagePlus;
import ij.ImageStack;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * マップの窓が値なし（NaN）に届く範囲の判定が、実際の計算と食い違わないこと。
 * 「届かない」と判定したのに値が変わる（静かに誤る）ものが 1 つも無いことを、カーネル・余白・2D/3D・向き・距離の総当たりで確かめる。
 */
class RadiomicsNanReachTest {

    static final int W = 24, H = 24, D = 12;
    // ROI: x 8..13, y 8..13, z 4..7
    static boolean roi(int x, int y, int z) { return x >= 8 && x <= 13 && y >= 8 && y <= 13 && z >= 4 && z <= 7; }

    static ImagePlus image(int[] nanAt) {
        ImageStack st = new ImageStack(W, H);
        long s = 99L;
        for (int z = 0; z < D; z++) {
            FloatProcessor ip = new FloatProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                s = s * 6364136223846793005L + 1442695040888963407L;
                ip.setf(x, y, (int) Math.floorMod(s >> 33, 40) + 10f);
            }
            st.addSlice(ip);
        }
        if (nanAt != null) st.getProcessor(nanAt[2] + 1).setf(nanAt[0], nanAt[1], Float.NaN);
        ImagePlus imp = new ImagePlus("p", st);
        imp.getCalibration().pixelWidth = 1; imp.getCalibration().pixelHeight = 1; imp.getCalibration().pixelDepth = 1;
        return imp;
    }

    static ImagePlus mask() {
        ImageStack st = new ImageStack(W, H);
        for (int z = 0; z < D; z++) {
            ByteProcessor ip = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) ip.set(x, y, roi(x, y, z) ? 1 : 0);
            st.addSlice(ip);
        }
        return new ImagePlus("m", st);
    }

    static float[][] map(String feature, int[] nanAt, int k, int margin, boolean d2, Path dir) {
        ImagePlus im = image(nanAt);
        String[] sops = new String[D];
        for (int z = 0; z < D; z++) sops[z] = "1.2.3." + z;
        RadiomicsMapEngine.LoadedVolume vol = new RadiomicsMapEngine.LoadedVolume(im, mask(), W, H, D, 1, true,
                im.getCalibration(), null, 1d, 1d, new HashMap<>(), sops, null, null, false);
        Map<String, String> settings = new HashMap<>();
        settings.put("MASK_LABEL_INT", "1");
        TextureSeriesRequest r = new TextureSeriesRequest("1.2", "1.2.9", "1.2.8", 0, feature, k, 1, d2, 0, 0, settings,
                margin, null, null);
        RadiomicsMapEngine eng = new RadiomicsMapEngine(null, new MapCheckpointStore(new CacheStore(dir, 0), "t"), null);
        return eng.computeFrom(r, TextureProgress.NONE, vol).map().data();
    }

    @Test
    void theReachRuleNeverMissesAValueThatChanges(@TempDir Path dir) {
        String[] feats = {"FIRSTORDER_Mean", "GLCM_JointEntropy", "GLRLM_RunEntropy", "NGTDM_Coarseness",
                "GLDZM_ZoneDistanceEntropy", "GLAM_PotentialEnergy_Mean"};
        boolean[][] roiMask = new boolean[D][W * H];
        for (int z = 0; z < D; z++) for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) roiMask[z][y * W + x] = roi(x, y, z);
        List<String> unsound = new ArrayList<>();
        int conservative = 0, exact = 0, changed = 0, n = 0;
        int seq = 0;
        for (int k : new int[] {3, 5, 7}) {
            for (int margin : new int[] {0, 2, 4}) {
                for (boolean d2 : new boolean[] {false, true}) {
                    for (String f : feats) {
                        if (f.startsWith("GLAM") && (d2 || k < 7)) continue;
                        float[][] clean = map(f, null, k, margin, d2, dir.resolve("c" + seq++));
                        for (int axis = 0; axis < 3; axis++) {
                            for (int d = 1; d <= 4; d++) {
                                int[] nanAt = switch (axis) {
                                    case 0 -> new int[] {8 - d, 10, 5};
                                    case 1 -> new int[] {10, 10, 4 - d};
                                    default -> new int[] {13 + d, 13 + d, 7 + d}; // 斜め（箱の隅）
                                };
                                float[][] m = map(f, nanAt, k, margin, d2, dir.resolve("n" + seq++));
                                int diff = 0;
                                for (int z = 0; z < D; z++) for (int i = 0; i < W * H; i++) if (roiMask[z][i]) {
                                    if (!(clean[z][i] == m[z][i] || (Float.isNaN(clean[z][i]) && Float.isNaN(m[z][i])))) diff++;
                                }
                                float[][] img = NanReach.slicesOf(image(nanAt), D);
                                NanReach.MapNan st = NanReach.assessForMap(img, roiMask, W, H, k, margin, d2);
                                boolean reached = st == NanReach.MapNan.REACHED;
                                n++;
                                if (diff > 0) changed++;
                                if (!reached && diff > 0) unsound.add(f + " k=" + k + " margin=" + margin + " 2D=" + d2 + " axis=" + axis + " d=" + d + " diff=" + diff);
                                if (reached && diff == 0) conservative++;
                                if (reached && diff > 0) exact++;
                            }
                        }
                    }
                }
            }
        }
        System.out.println("NANREACH cases=" + n + " changed=" + changed + " reachedAndChanged=" + exact
                + " reachedButUnchanged(conservative)=" + conservative + " unsound=" + unsound.size());
        unsound.stream().limit(15).forEach(s -> System.out.println("NANREACH UNSOUND " + s));
        assertTrue(unsound.isEmpty(), "届かないと判定したのに値が変わった: " + unsound.size() + " 件（先頭: "
                + (unsound.isEmpty() ? "" : unsound.get(0)) + "）");
        assertTrue(changed > 0, "前提: 値が変わる場合が実在する");
    }

    // ───────────── 純関数 ─────────────

    private static boolean[][] roiMask() {
        boolean[][] r = new boolean[D][W * H];
        for (int z = 0; z < D; z++) for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) r[z][y * W + x] = roi(x, y, z);
        return r;
    }

    private static float[][] withNan(int... xyz) {
        float[][] img = NanReach.slicesOf(image(null), D);
        for (int i = 0; i < xyz.length; i += 3) img[xyz[i + 2]][xyz[i + 1] * W + xyz[i]] = Float.NaN;
        return img;
    }

    @Test
    void localPeakRadiusIsTheOneCubicCentimetreSphere() {
        assertEquals(6.2035, NanReach.LOCAL_PEAK_RADIUS_MM, 1e-3);
        assertEquals(1000.0, 4.0 / 3.0 * Math.PI * Math.pow(NanReach.LOCAL_PEAK_RADIUS_MM, 3), 1e-6);
    }

    @Test
    void roiAssessment() {
        boolean[][] roi = roiMask();
        assertEquals(NanReach.RoiNan.NONE, NanReach.assessForRoi(withNan(), roi, W, H, 1, 1, 1));
        assertEquals(NanReach.RoiNan.INSIDE, NanReach.assessForRoi(withNan(10, 10, 5), roi, W, H, 1, 1, 1));
        // ROI の 1 mm 隣・6 mm 隣は近傍の内、7 mm 隣は外
        assertEquals(NanReach.RoiNan.OUTSIDE_NEAR, NanReach.assessForRoi(withNan(7, 10, 5), roi, W, H, 1, 1, 1));
        assertEquals(NanReach.RoiNan.OUTSIDE_NEAR, NanReach.assessForRoi(withNan(2, 10, 5), roi, W, H, 1, 1, 1));
        assertEquals(NanReach.RoiNan.OUTSIDE_FAR, NanReach.assessForRoi(withNan(1, 10, 5), roi, W, H, 1, 1, 1));
        assertEquals(NanReach.RoiNan.OUTSIDE_FAR, NanReach.assessForRoi(withNan(0, 0, 0), roi, W, H, 1, 1, 1));
        // 箱の隅（各軸 4 画素 = 距離 6.93 mm）は、箱では内でも球では外
        assertEquals(NanReach.RoiNan.OUTSIDE_FAR, NanReach.assessForRoi(withNan(4, 4, 0), roi, W, H, 1, 1, 1));
        // 画素間隔が違えば画素数が変わる: z が 3 mm なら、2 スライス（6 mm）隣は内、3 スライス（9 mm）隣は外
        assertEquals(NanReach.RoiNan.OUTSIDE_NEAR, NanReach.assessForRoi(withNan(10, 10, 2), roi, W, H, 1, 1, 3));
        assertEquals(NanReach.RoiNan.OUTSIDE_FAR, NanReach.assessForRoi(withNan(10, 10, 1), roi, W, H, 1, 1, 3));
    }

    @Test
    void mapAssessmentUsesTheSmallerOfKernelRadiusAndMargin() {
        boolean[][] roi = roiMask();
        assertEquals(2, NanReach.mapReachVoxels(5, 4));
        assertEquals(1, NanReach.mapReachVoxels(7, 1));
        assertEquals(0, NanReach.mapReachVoxels(7, 0));
        assertEquals(NanReach.MapNan.NONE, NanReach.assessForMap(withNan(), roi, W, H, 5, 2, false));
        assertEquals(NanReach.MapNan.INSIDE, NanReach.assessForMap(withNan(10, 10, 5), roi, W, H, 5, 2, false));
        assertEquals(NanReach.MapNan.REACHED, NanReach.assessForMap(withNan(6, 10, 5), roi, W, H, 5, 2, false));
        assertEquals(NanReach.MapNan.OUTSIDE_FAR, NanReach.assessForMap(withNan(5, 10, 5), roi, W, H, 5, 2, false));
        assertEquals(NanReach.MapNan.OUTSIDE_FAR, NanReach.assessForMap(withNan(7, 10, 5), roi, W, H, 5, 0, false));
        // 2D は隣のスライスの NaN に届かない
        assertEquals(NanReach.MapNan.REACHED, NanReach.assessForMap(withNan(10, 10, 3), roi, W, H, 5, 2, false));
        assertEquals(NanReach.MapNan.OUTSIDE_FAR, NanReach.assessForMap(withNan(10, 10, 3), roi, W, H, 5, 2, true));
    }

    // ───────────── 入口（compute）で断る・通す ─────────────

    static final class FixedEngine extends RadiomicsMapEngine {
        final LoadedVolume vol;
        FixedEngine(LoadedVolume vol, Path dir) {
            super(null, new MapCheckpointStore(new CacheStore(dir, 0), "t"), null);
            this.vol = vol;
        }
        @Override
        public LoadedVolume load(String study, String series, int channel, int timePoint, String maskSeries,
                                 int maskChannel, int label, Map<String, String> settings, boolean allowRectify) {
            // 入口が NaN を読む指定を付けていること（付けないと、実際の読み込みは 1 つでも NaN があれば断る）
            assertEquals("1", settings.get(RadiomicsMapEngine.ALLOW_NAN_SETTING));
            return vol;
        }
    }

    private static RadiomicsMapEngine.LoadedVolume volumeWith(float[][] pixels) {
        ImageStack st = new ImageStack(W, H);
        for (int z = 0; z < D; z++) st.addSlice(new FloatProcessor(W, H, pixels[z].clone()));
        ImagePlus im = new ImagePlus("p", st);
        im.getCalibration().pixelWidth = 1; im.getCalibration().pixelHeight = 1; im.getCalibration().pixelDepth = 1;
        String[] sops = new String[D];
        for (int z = 0; z < D; z++) sops[z] = "1.2.3." + z;
        return new RadiomicsMapEngine.LoadedVolume(im, mask(), W, H, D, 1, true, im.getCalibration(), null, 1d, 1d,
                new HashMap<>(), sops, null, null, false);
    }

    private static TextureSeriesRequest request(int k, int margin) {
        Map<String, String> settings = new HashMap<>();
        settings.put("MASK_LABEL_INT", "1");
        return new TextureSeriesRequest("1.2", "1.2.9", "1.2.8", 0, "FIRSTORDER_Mean", k, 1, false, 0, 0, settings,
                margin, null, null);
    }

    @Test
    void aMapOfAMapIsRefusedWithAHintToUseTheOriginalImage(@TempDir Path dir) throws Exception {
        // マスクつきテクスチャマップ: ROI の外が全部 NaN
        float[][] px = NanReach.slicesOf(image(null), D);
        for (int z = 0; z < D; z++) for (int i = 0; i < W * H; i++) if (!roiMask()[z][i]) px[z][i] = Float.NaN;
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new FixedEngine(volumeWith(px), dir).compute(request(5, 2), TextureProgress.NONE));
        assertTrue(e.getMessage().contains("窓が届く範囲"), e.getMessage());
        assertTrue(e.getMessage().contains("テクスチャマップ") && e.getMessage().contains("元の画像"), e.getMessage());
        // 余白 0 でも ROI の外が全部 NaN なら、カーネルの半径が 0 になり届かない（窓が ROI の外を見ない）→ 通す。
        // 窓の値は NaN の無い画像と同じ（ROI の外が NaN でも、余白 0 では見られない）
        RadiomicsMapEngine.MapResult clean = new FixedEngine(volumeWith(NanReach.slicesOf(image(null), D)), dir.resolve("c"))
                .compute(request(5, 0), TextureProgress.NONE);
        RadiomicsMapEngine.MapResult masked = new FixedEngine(volumeWith(px), dir.resolve("m")).compute(request(5, 0), TextureProgress.NONE);
        for (int z = 0; z < D; z++) for (int i = 0; i < W * H; i++) if (roiMask()[z][i]) {
            assertEquals(clean.data()[z][i], masked.data()[z][i], 0f);
        }
    }

    @Test
    void nanInsideTheRoiIsRefusedByTheMapEntrance(@TempDir Path dir) {
        float[][] px = withNan(10, 10, 5);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new FixedEngine(volumeWith(px), dir).compute(request(5, 2), TextureProgress.NONE));
        assertTrue(e.getMessage().contains("ROI の内側"), e.getMessage());
    }
}
