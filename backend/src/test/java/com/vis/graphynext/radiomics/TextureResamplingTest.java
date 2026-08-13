/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 計算前リサンプリングの回帰テスト。
 *
 * <p>守りたいのは 1 点に尽きる — <b>順変換（RadiomicsJ の補間）と逆変換（元の格子へ戻す）が
 * 同じ格子合わせを使っていること</b>。ここがずれると、マップは「それらしく」出るのに
 * 元画像に対して半ボクセル〜数ボクセル平行移動した絵になり、目視では気づけない。
 * 線形勾配は Trilinear で厳密に保たれるので、往復して元の値に戻るかで確かめられる。
 */
class TextureResamplingTest {

    private static final int W = 16;
    private static final int H = 12;
    private static final int S = 8;

    /** 値が座標の線形関数になっているボリューム（Trilinear なら補間しても関係が崩れない）。 */
    private static ImagePlus rampVolume(double sx, double sy, double sz) {
        ImageStack stack = new ImageStack(W, H);
        for (int z = 0; z < S; z++) {
            FloatProcessor fp = new FloatProcessor(W, H);
            for (int y = 0; y < H; y++) {
                for (int x = 0; x < W; x++) {
                    fp.setf(x, y, x + 2f * y + 3f * z);
                }
            }
            stack.addSlice(fp);
        }
        ImagePlus imp = new ImagePlus("ramp", stack);
        Calibration cal = imp.getCalibration();
        cal.pixelWidth = sx;
        cal.pixelHeight = sy;
        cal.pixelDepth = sz;
        cal.setUnit("mm");
        imp.setCalibration(cal);
        return imp;
    }

    /** 中央付近だけ塗ったマスク。 */
    private static ImagePlus boxMask(int label) {
        ImageStack stack = new ImageStack(W, H);
        for (int z = 0; z < S; z++) {
            ByteProcessor bp = new ByteProcessor(W, H);
            for (int y = 3; y < H - 3; y++) {
                for (int x = 3; x < W - 3; x++) {
                    bp.set(x, y, label);
                }
            }
            stack.addSlice(bp);
        }
        return new ImagePlus("mask", stack);
    }

    private static Map<String, String> settings(String... kv) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    // ── 設定の解釈 ──────────────────────────────────────────────

    @Test
    void resamplingIsOffUnlessAskedFor() {
        assertNull(TextureResampling.targetSpacing(null));
        assertNull(TextureResampling.targetSpacing(settings()));
        assertNull(TextureResampling.targetSpacing(settings("Resampling_BOOL", "0",
                "ResamplingX_DOUBLE", "1", "ResamplingY_DOUBLE", "1", "ResamplingZ_DOUBLE", "1")));
    }

    @Test
    void readsTheTargetSpacing() {
        double[] t = TextureResampling.targetSpacing(settings("Resampling_BOOL", "1",
                "ResamplingX_DOUBLE", "1.5", "ResamplingY_DOUBLE", "1.5", "ResamplingZ_DOUBLE", "2"));
        assertNotNull(t);
        assertEquals(1.5, t[0], 1e-9);
        assertEquals(2.0, t[2], 1e-9);
    }

    @Test
    void fallsBackToTheRegistryDefaultWhenOnlyTheCheckboxWasTouched() {
        // 設定は「利用者が触った項目しか保存されない」ので、チェックだけ入れると
        // Resampling_BOOL しか届かない。UI には 1mm と出ているので、そこへ合わせる。
        // （実機で最初に踏んだのがこれ。エラーで止まっていた。）
        double[] t = TextureResampling.targetSpacing(settings("Resampling_BOOL", "true"));
        assertNotNull(t);
        assertEquals(TextureResampling.DEFAULT_SPACING_MM, t[0], 1e-9);
        assertEquals(TextureResampling.DEFAULT_SPACING_MM, t[1], 1e-9);
        assertEquals(TextureResampling.DEFAULT_SPACING_MM, t[2], 1e-9);
    }

    @Test
    void refusesAnExplicitZeroTarget() {
        // 明示的に 0 を入れられた場合は既定で埋めない。黙って 0mm 格子を作らせない。
        assertThrows(IllegalArgumentException.class, () -> TextureResampling.targetSpacing(
                settings("Resampling_BOOL", "1", "ResamplingX_DOUBLE", "0",
                        "ResamplingY_DOUBLE", "0", "ResamplingZ_DOUBLE", "0")));
    }

    @Test
    void refusesAnAbsurdlyFineTarget() {
        assertThrows(IllegalArgumentException.class, () -> TextureResampling.targetSpacing(
                settings("Resampling_BOOL", "1", "ResamplingX_DOUBLE", "0.001",
                        "ResamplingY_DOUBLE", "0.001", "ResamplingZ_DOUBLE", "0.001")));
    }

    @Test
    void describesWhatWasUsedForTheDerivationDescription() {
        assertEquals("off", TextureResampling.describe(settings()));
        assertEquals("1x1x1mm", TextureResampling.describe(settings("Resampling_BOOL", "1",
                "ResamplingX_DOUBLE", "1", "ResamplingY_DOUBLE", "1", "ResamplingZ_DOUBLE", "1")));
    }

    // ── 増加率のガード ──────────────────────────────────────────

    @Test
    void refusesWhenTheGridWouldExplode() {
        // 0.645x0.645x5.0 の CT を 0.2mm 等方にすると 200 倍を超える。
        assertThrows(IllegalArgumentException.class, () -> TextureResampling.plan(
                512, 512, 50, new double[]{0.645, 0.645, 5.0}, new double[]{0.2, 0.2, 0.2}));
    }

    @Test
    void allowsARealisticIsotropicTarget() {
        int[] planned = TextureResampling.plan(512, 512, 50,
                new double[]{0.645, 0.645, 5.0}, new double[]{1.0, 1.0, 1.0});
        assertEquals(331, planned[0]);
        assertEquals(331, planned[1]);
        assertEquals(250, planned[2]);
    }

    @Test
    void skipsWhenTheVolumeIsAlreadyAtTheTarget() {
        assertTrue(TextureResampling.alreadyMatches(new double[]{1, 1, 1}, new double[]{1, 1, 1}));
        assertTrue(TextureResampling.alreadyMatches(new double[]{0.5, 0.5, 0.5}, new double[]{0.5, 0.5, 0.5000001}));
        assertTrue(!TextureResampling.alreadyMatches(new double[]{0.645, 0.645, 5}, new double[]{1, 1, 1}));
    }

    // ── 往復（ここが本題） ──────────────────────────────────────

    @Test
    void mapsBackOntoTheSourceGridWithoutShifting() {
        double[] source = {1.0, 1.0, 2.0};
        double[] target = {0.5, 0.5, 0.5};
        ImagePlus img = rampVolume(source[0], source[1], source[2]);
        ImagePlus[] resampled = TextureResampling.resample(img, boxMask(1), 1, target);
        ImagePlus r = resampled[0];

        TextureResampling.Grid grid = TextureResampling.Grid.of(W, H, S,
                r.getWidth(), r.getHeight(), r.getNSlices(), source, target);

        // リサンプリング格子の画素値を「マップ」に見立てて、元の格子へ戻す。
        float[][] computed = new float[r.getNSlices()][];
        for (int z = 0; z < r.getNSlices(); z++) {
            computed[z] = (float[]) r.getStack().getProcessor(z + 1).convertToFloatProcessor().getPixels();
        }
        float[][] back = TextureResampling.toSourceGrid(computed, r.getWidth(), r.getHeight(),
                r.getNSlices(), grid);

        assertEquals(S, back.length);
        assertEquals(W * H, back[0].length);
        // 端は補間が端で丸められるので内側だけを見る。線形なので厳密に一致するはず。
        for (int z = 1; z < S - 1; z++) {
            for (int y = 1; y < H - 1; y++) {
                for (int x = 1; x < W - 1; x++) {
                    assertEquals(x + 2.0 * y + 3.0 * z, back[z][y * W + x], 1e-3,
                            "voxel (" + x + ", " + y + ", " + z + ") が元の位置に戻っていない");
                }
            }
        }
    }

    @Test
    void keepsTheLabelValueThroughTheMaskResample() {
        double[] target = {0.5, 0.5, 1.0};
        // ラベル 3 のマスク。RadiomicsJ の resample3D はラベル 1 しか受け付けないので、
        // 行き帰りでラベルを付け替えているかを確かめる。
        ImagePlus[] out = TextureResampling.resample(rampVolume(1, 1, 2), boxMask(3), 3, target);
        ImagePlus mask = out[1];
        assertEquals(out[0].getWidth(), mask.getWidth());
        assertEquals(out[0].getNSlices(), mask.getNSlices());
        int hits = 0;
        for (int z = 0; z < mask.getNSlices(); z++) {
            for (int y = 0; y < mask.getHeight(); y++) {
                for (int x = 0; x < mask.getWidth(); x++) {
                    float v = mask.getStack().getProcessor(z + 1).getf(x, y);
                    assertTrue(v == 0f || v == 3f, "マスクに 0/3 以外の値がある: " + v);
                    if (v == 3f) hits++;
                }
            }
        }
        assertTrue(hits > 0, "リサンプリング後のマスクが空になっている");
    }
}
