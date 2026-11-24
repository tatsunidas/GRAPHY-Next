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
import io.github.tatsunidas.radiomics.main.FeatureVisualizationMap;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ROI の周りへ切り出して RadiomicsJ に渡す経路は、全ボリュームを渡す従来の経路と全画素（float のビット）一致する。
 * 旧経路は {@code cropEnabled=false}（同じコードで切り出しだけ外す）。値が全 0 の一致を合格にしないよう、
 * 非 0 の画素数も数える。
 */
class MapCropTest {

    private static final int W = 40, H = 36, D = 18;

    private static ImagePlus phantom() {
        ImageStack st = new ImageStack(W, H);
        long s = 4242L;
        for (int z = 0; z < D; z++) {
            FloatProcessor ip = new FloatProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                s = s * 6364136223846793005L + 1442695040888963407L;
                ip.setf(x, y, (int) Math.floorMod(s >> 33, 14) * 50f + z + x * 0.5f);
            }
            st.addSlice(ip);
        }
        ImagePlus imp = new ImagePlus("p", st);
        imp.getCalibration().pixelWidth = 1d;
        imp.getCalibration().pixelHeight = 1d;
        imp.getCalibration().pixelDepth = 1d;
        return imp;
    }

    /** x, y, z の ROI 述語。 */
    private interface Roi { boolean in(int x, int y, int z); }

    private static final Roi INTERIOR = (x, y, z) -> x >= 15 && x < 23 && y >= 14 && y < 21 && z >= 6 && z < 11;
    /** 2 つの塊。z=8 のスライスは空。 */
    private static final Roi TWO_BLOCKS = (x, y, z) -> z != 8 && (
            (x >= 12 && x < 18 && y >= 12 && y < 17 && z >= 5 && z < 11)
                    || (x >= 24 && x < 29 && y >= 20 && y < 25 && z >= 7 && z < 12));
    /** x=0 に届く（余白以内）。 */
    private static final Roi LEFT_EDGE = (x, y, z) -> x >= 0 && x < 6 && y >= 14 && y < 21 && z >= 6 && z < 11;
    /** z の端に届く（3D のとき余白以内。2D では ROI が縁に無い x・y のみなので縁にかからない）。 */
    private static final Roi Z_EDGE = (x, y, z) -> x >= 15 && x < 23 && y >= 14 && y < 21 && z >= 0 && z < 4;

    private static ImagePlus mask(Roi roi) {
        ImageStack st = new ImageStack(W, H);
        for (int z = 0; z < D; z++) {
            ByteProcessor ip = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) ip.set(x, y, roi.in(x, y, z) ? 1 : 0);
            st.addSlice(ip);
        }
        return new ImagePlus("m", st);
    }

    private static RadiomicsMapEngine.LoadedVolume volume(Roi roi) {
        ImagePlus img = phantom();
        String[] sops = new String[D];
        for (int z = 0; z < D; z++) sops[z] = "1.2.3." + z;
        return new RadiomicsMapEngine.LoadedVolume(img, mask(roi), W, H, D, 1, true, img.getCalibration(),
                null, 1d, 1d, new HashMap<>(), sops, null, null, false);
    }

    private static TextureSeriesRequest req(String feature, int k, int stride, boolean d2, int margin) {
        Map<String, String> settings = new HashMap<>();
        settings.put("MASK_LABEL_INT", "1");
        settings.put("BINCOUNT_GLAM_BOOL", "true");
        settings.put("BINCOUNT_GLAM_INT", "8");
        return new TextureSeriesRequest("1.2", "1.2.9", "1.2.8", 0, feature, k, stride, d2, 0, 0, settings, margin, null, null);
    }

    private static float[][] run(Path dir, boolean crop, Roi roi, String feature, int k, int stride, boolean d2, int margin) {
        RadiomicsMapEngine eng = new RadiomicsMapEngine(null, new MapCheckpointStore(new CacheStore(dir, 0), "t"), null);
        eng.cropEnabled = crop;
        return eng.computeFrom(req(feature, k, stride, d2, margin), TextureProgress.NONE, volume(roi)).map().data();
    }

    private int n;

    /** 旧・新を同じ入力で走らせ、全画素がビット一致することを確かめる。ROI 内の非 0 の数を返す。 */
    private int same(Path tmp, Roi roi, String feature, int k, int stride, boolean d2, int margin) {
        String tag = feature + " k=" + k + " stride=" + stride + " d2=" + d2 + " margin=" + margin;
        float[][] old = run(tmp.resolve("o" + n), false, roi, feature, k, stride, d2, margin);
        float[][] now = run(tmp.resolve("n" + n++), true, roi, feature, k, stride, d2, margin);
        int nonZero = 0;
        for (int z = 0; z < D; z++) {
            assertEquals(old[z].length, now[z].length, tag);
            for (int i = 0; i < old[z].length; i++) {
                assertEquals(Float.floatToRawIntBits(old[z][i]), Float.floatToRawIntBits(now[z][i]),
                        tag + " (" + (i % W) + "," + (i / W) + "," + z + ") old=" + old[z][i] + " new=" + now[z][i]);
                if (old[z][i] != 0f && !Float.isNaN(old[z][i])) nonZero++;
            }
        }
        assertTrue(nonZero > 0, "全 0 同士の一致は検査にならない: " + tag);
        return nonZero;
    }

    private static final String[] FAMILIES = {"GLCM_JointEntropy", "FIRSTORDER_Mean", "GLRLM_RunEntropy", "GLSZM_SmallZoneEmphasis"};

    @Test
    void interiorRoi_everyFamily_3D2D_stride_margin_kernel(@TempDir Path tmp) {
        MapCrop plan = MapCrop.plan(mask(INTERIOR), 3, 7, false, 1);
        assertNull(plan.fallbackReason(), "前提: 内部の ROI は切り出せる");
        for (String f : FAMILIES) {
            for (boolean d2 : new boolean[]{false, true}) {
                for (int stride : new int[]{1, 2}) {
                    for (int margin : new int[]{0, 1, 3}) {
                        for (int k : new int[]{3, 5, 7}) {
                            same(tmp, INTERIOR, f, k, stride, d2, margin);
                        }
                    }
                }
            }
        }
    }

    @Test
    void glam_3D(@TempDir Path tmp) {
        for (int stride : new int[]{1, 2}) {
            for (int margin : new int[]{0, 3}) {
                same(tmp, INTERIOR, "GLAM_RDFPeakPosition_Mean", 7, stride, false, margin);
            }
        }
    }

    @Test
    void twoBlocksAndEmptySlice(@TempDir Path tmp) {
        MapCrop plan = MapCrop.plan(mask(TWO_BLOCKS), 3, 7, false, 1);
        assertNull(plan.fallbackReason());
        assertTrue(plan.emptySlice(8), "前提: z=8 は空のスライス");
        for (String f : new String[]{"GLCM_JointEntropy", "GLSZM_SmallZoneEmphasis"}) {
            for (boolean d2 : new boolean[]{false, true}) {
                for (int stride : new int[]{1, 2}) {
                    for (int margin : new int[]{0, 3}) {
                        same(tmp, TWO_BLOCKS, f, 5, stride, d2, margin);
                    }
                }
            }
        }
        same(tmp, TWO_BLOCKS, "GLAM_RDFPeakPosition_Mean", 7, 1, false, 3);
    }

    @Test
    void roiAtTheBorder_fallsBackAndStillMatches(@TempDir Path tmp) {
        assertNotNull(MapCrop.plan(mask(LEFT_EDGE), 3, 7, false, 1).fallbackReason(), "縁に届く ROI は切り出さない");
        assertNotNull(MapCrop.plan(mask(Z_EDGE), 3, 7, false, 1).fallbackReason(), "z の縁（3D）も同じ");
        assertNull(MapCrop.plan(mask(Z_EDGE), 3, 7, true, 1).fallbackReason(), "2D では z の縁は縁ではない");
        assertNull(MapCrop.plan(mask(LEFT_EDGE), 0, 7, false, 1).fallbackReason(), "余白 0 では縁の延長は走らない");
        for (Roi roi : new Roi[]{LEFT_EDGE, Z_EDGE}) {
            same(tmp, roi, "GLCM_JointEntropy", 7, 1, false, 3);
            same(tmp, roi, "GLSZM_SmallZoneEmphasis", 5, 2, false, 1);
            same(tmp, roi, "GLCM_JointEntropy", 7, 1, true, 3);
            same(tmp, roi, "GLCM_JointEntropy", 7, 1, false, 0);
        }
    }

    @Test
    void borderRule_matchesRadiomicsJ_atTheMarginBoundary() {
        // 縁からちょうど margin 離れている（x=3, margin=3）は縁でない。1 画素近い（x=2）は縁。
        assertNull(MapCrop.plan(mask((x, y, z) -> x >= 3 && x < 9 && y >= 14 && y < 21 && z >= 6 && z < 11), 3, 7, false, 1).fallbackReason());
        assertNotNull(MapCrop.plan(mask((x, y, z) -> x >= 2 && x < 9 && y >= 14 && y < 21 && z >= 6 && z < 11), 3, 7, false, 1).fallbackReason());
        assertNull(MapCrop.plan(mask((x, y, z) -> x >= 15 && x < W - 3 && y >= 14 && y < 21 && z >= 6 && z < 11), 3, 7, false, 1).fallbackReason());
        assertNotNull(MapCrop.plan(mask((x, y, z) -> x >= 15 && x < W - 2 && y >= 14 && y < 21 && z >= 6 && z < 11), 3, 7, false, 1).fallbackReason());
    }

    /** 負例: 切り出しを 1 画素小さくする（窓が読む範囲を削る）と、不一致が検出される。 */
    @Test
    void shrunkenRegion_isDetected() {
        ImagePlus img = phantom();
        ImagePlus m = mask(INTERIOR);
        int k = 7, margin = 3, z = 8;
        MapCrop plan = MapCrop.plan(m, margin, k, false, 1);
        MapCrop.Region r = plan.region(z);
        TextureFeatureCatalog.BuiltFeature built = TextureFeatureCatalog.build("GLCM_JointEntropy", Map.of("MASK_LABEL_INT", "1"), k);
        float[] whole = (float[]) FeatureVisualizationMap.generateFeatureMap(img, m, z + 1, built.calculator(), k, false, 1, margin)
                .getStack().getProcessor(1).convertToFloatProcessor().getPixels();
        // 正例: 計画どおりの範囲では一致（x・y の窓の外側の余白を含む）
        assertEquals(0, diff(whole, crop(img, m, r, z, margin, k, false), r));
        // 窓が画素を読む最小の範囲は外接箱 ± 半径。その内側へ 1 画素削る: 左右・上下それぞれで不一致
        int g = k / 2;
        int bx0 = 15, bx1 = 22, by0 = 14, by1 = 20;
        MapCrop.Region[] cut = {
                new MapCrop.Region(bx0 - g + 1, r.x1(), r.y0(), r.y1(), r.z0(), r.z1(), r.keepLo(), r.keepHi()),
                new MapCrop.Region(r.x0(), bx1 + g - 1, r.y0(), r.y1(), r.z0(), r.z1(), r.keepLo(), r.keepHi()),
                new MapCrop.Region(r.x0(), r.x1(), by0 - g + 1, r.y1(), r.z0(), r.z1(), r.keepLo(), r.keepHi()),
                new MapCrop.Region(r.x0(), r.x1(), r.y0(), by1 + g - 1, r.z0(), r.z1(), r.keepLo(), r.keepHi()),
        };
        for (MapCrop.Region c : cut) {
            // 切り出しが小さくなるので、縁の延長（border pad）が走る・窓が欠ける、のどちらかで値が変わる
            assertTrue(diffOnWindow(whole, crop(img, m, c, z, margin, k, false), c) > 0, "削った切り出しは不一致になる: " + c);
        }
    }

    private static float[] crop(ImagePlus img, ImagePlus m, MapCrop.Region r, int z, int margin, int k, boolean d2) {
        TextureFeatureCatalog.BuiltFeature built = TextureFeatureCatalog.build("GLCM_JointEntropy", Map.of("MASK_LABEL_INT", "1"), k);
        ImagePlus out = FeatureVisualizationMap.generateFeatureMap(MapCrop.cropImage(img, r), MapCrop.cropMask(m, r),
                z - r.z0() + 1, built.calculator(), k, d2, 1, margin);
        return (float[]) out.getStack().getProcessor(1).convertToFloatProcessor().getPixels();
    }

    /** 切り出し側の出力を元の位置へ戻して、全体との差の画素数を数える。 */
    private static int diff(float[] whole, float[] part, MapCrop.Region r) {
        int bad = 0;
        for (int y = 0; y < r.height(); y++) for (int x = 0; x < r.width(); x++) {
            if (Float.floatToRawIntBits(whole[(r.y0() + y) * W + r.x0() + x]) != Float.floatToRawIntBits(part[y * r.width() + x])) bad++;
        }
        return bad;
    }

    private static int diffOnWindow(float[] whole, float[] part, MapCrop.Region r) {
        return diff(whole, part, r);
    }
}
