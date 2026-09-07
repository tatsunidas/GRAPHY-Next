/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.anonymize.AnonymizeMaskStore.MaskPolygon;
import com.vis.graphynext.anonymize.PolygonRasterizer.Run;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 焼き込みマスクのラスタ化（Spring 不要・ImageJ 不要）。
 *
 * <p>判定規約は frontend の {@code roiStats.ts} / {@code roiBooleanOps.ts} と同じ
 * 「<b>画素中心 {@code (x+0.5, y+0.5)} の偶奇則</b>」。揃えないと「ROI 統計が測った領域」と
 * 「焼き込んだ領域」がズレる。
 */
class PolygonRasterizerTest {

    private static MaskPolygon poly(double[] xs, double[] ys) {
        return new MaskPolygon(xs, ys, List.of(), List.of());
    }

    /** 塗られた画素の集合（"x,y"）。 */
    private static Set<String> painted(List<Run> runs) {
        Set<String> out = new TreeSet<>();
        for (Run r : runs) {
            for (int x = r.xStart(); x < r.xEnd(); x++) {
                out.add(x + "," + r.y());
            }
        }
        return out;
    }

    private static boolean isPainted(List<Run> runs, int x, int y) {
        for (Run r : runs) {
            if (r.y() == y && x >= r.xStart() && x < r.xEnd()) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------------------
    // 矩形: 既存の塗り結果を 1 画素も変えない
    // ------------------------------------------------------------------------

    @Test
    void rect_matchesLegacyRectangleFill() {
        // 旧実装は [x, x+w) × [y, y+h) を塗っていた。4 頂点の多角形として通しても同じになること。
        // 🔴 これが崩れると、既に登録済みのマスクで塗られる範囲が黙って変わる。
        int x = 3;
        int y = 4;
        int w = 5;
        int h = 6;
        List<Run> runs = PolygonRasterizer.runsFor(
                poly(new double[] { x, x + w, x + w, x }, new double[] { y, y, y + h, y + h }), 32, 32, 0);

        Set<String> expected = new TreeSet<>();
        for (int yy = y; yy < y + h; yy++) {
            for (int xx = x; xx < x + w; xx++) {
                expected.add(xx + "," + yy);
            }
        }
        assertEquals(expected, painted(runs), "矩形の塗り範囲が旧実装と一致する");
    }

    @Test
    void rect_producesOneRunPerRow() {
        List<Run> runs = PolygonRasterizer.runsFor(
                poly(new double[] { 2, 10, 10, 2 }, new double[] { 2, 2, 8, 8 }), 32, 32, 0);
        assertEquals(6, runs.size(), "矩形は 1 行 1 区間に畳まれる（Arrays.fill が 1 回で済む）");
    }

    // ------------------------------------------------------------------------
    // 🔴 ImageJRoiDto を捨てた理由の回帰
    // ------------------------------------------------------------------------

    @Test
    void rotatedEllipse_isNotAxisAlignedBoundingBox() {
        // 45 度回転した楕円（中心 (20,20)・長半径 12・短半径 4）を頂点列で表す。
        //
        // 🔴 これが ImageJRoiDto を捨てた理由の回帰。あの交換型は頂点の min/max から
        // 軸平行 bbox を作って oval をそこに潰す。この楕円の bbox は一辺 ≈ 17.9 の正方形なので、
        // bbox に収まる楕円＝半径 ≈ 8.94 の **円** になる。真の楕円とは別物で、
        //   ・長軸方向（45 度）は真の楕円のほうが遠くまで内側 → **塗り足りない**（致命的）
        //   ・短軸方向は真の楕円のほうが早く外側 → 円のほうが余分に塗る
        // ここでは両方向の代表点で、円ではなく楕円になっていることを示す。
        double cx = 20;
        double cy = 20;
        double a = 12;
        double b = 4;
        double rot = Math.PI / 4;
        int n = 180;
        double[] xs = new double[n];
        double[] ys = new double[n];
        for (int i = 0; i < n; i++) {
            double t = 2 * Math.PI * i / n;
            double ex = a * Math.cos(t);
            double ey = b * Math.sin(t);
            xs[i] = cx + ex * Math.cos(rot) - ey * Math.sin(rot);
            ys[i] = cy + ex * Math.sin(rot) + ey * Math.cos(rot);
        }
        List<Run> runs = PolygonRasterizer.runsFor(poly(xs, ys), 40, 40, 0);

        assertTrue(isPainted(runs, 20, 20), "中心は内側");

        // 長軸（右下 45 度）方向、中心から約 10.6 画素。真の楕円では内側だが、
        // bbox から作った半径 8.94 の円では **外側** になる＝そちらだと塗り漏れる。
        assertTrue(isPainted(runs, 27, 27),
                "長軸方向は遠くまで内側（bbox 近似だとここが塗られず、焼き込み文字が残る）");

        // 短軸（左下 45 度）方向、中心から約 6.4 画素。真の楕円では外側だが、
        // 半径 8.94 の円なら内側＝bbox 近似は形が違うことのもう一方の証拠。
        assertFalse(isPainted(runs, 15, 24), "短軸方向は近くても外側（円ではない）");

        // 長軸の先端は中心から 12 画素。画素 (28,28) の中心は 12.02 画素なので **わずかに外**。
        // 頂点列の分割が粗いと内側に化けるので、長半径どおりに切れていることの確認になる。
        assertFalse(isPainted(runs, 28, 28), "長軸の先端（12 画素）をわずかに超えた画素は外側");
    }

    @Test
    void axisAlignedEllipse_excludesCorners() {
        int n = 180;
        double[] xs = new double[n];
        double[] ys = new double[n];
        for (int i = 0; i < n; i++) {
            double t = 2 * Math.PI * i / n;
            xs[i] = 20 + 10 * Math.cos(t);
            ys[i] = 20 + 10 * Math.sin(t);
        }
        List<Run> runs = PolygonRasterizer.runsFor(poly(xs, ys), 40, 40, 0);
        assertTrue(isPainted(runs, 20, 20), "中心は内側");
        assertFalse(isPainted(runs, 11, 11), "bbox の四隅は外側");
        assertFalse(isPainted(runs, 29, 29), "bbox の四隅は外側");
    }

    // ------------------------------------------------------------------------
    // 形状
    // ------------------------------------------------------------------------

    @Test
    void triangle_fillsInterior_andExcludesExterior() {
        List<Run> runs = PolygonRasterizer.runsFor(
                poly(new double[] { 0, 20, 0 }, new double[] { 0, 0, 20 }), 32, 32, 0);
        assertTrue(isPainted(runs, 2, 2), "内側");
        assertFalse(isPainted(runs, 18, 18), "斜辺の外側");
    }

    @Test
    void concavePolygon_doesNotFillConcavity() {
        // コの字。偶奇則の実装ミスがあれば凹部が埋まる。
        double[] xs = { 0, 30, 30, 10, 10, 30, 30, 0 };
        double[] ys = { 0, 0, 10, 10, 20, 20, 30, 30 };
        List<Run> runs = PolygonRasterizer.runsFor(poly(xs, ys), 40, 40, 0);
        assertTrue(isPainted(runs, 5, 15), "左の縦棒は内側");
        assertTrue(isPainted(runs, 20, 5), "上の横棒は内側");
        assertFalse(isPainted(runs, 20, 15), "凹部は塗られない");
    }

    @Test
    void concavePolygon_producesTwoRunsOnTheConcaveRow() {
        double[] xs = { 0, 30, 30, 10, 10, 30, 30, 0 };
        double[] ys = { 0, 0, 10, 10, 20, 20, 30, 30 };
        List<Run> runs = PolygonRasterizer.runsFor(poly(xs, ys), 40, 40, 0);
        long onRow15 = runs.stream().filter(r -> r.y() == 15).count();
        assertEquals(1, onRow15, "凹部のある行は左の縦棒だけの 1 区間");
    }

    // ------------------------------------------------------------------------
    // 境界規約・膨張・クリップ
    // ------------------------------------------------------------------------

    @Test
    void pixelCenterRule_matchesFrontendConvention() {
        // [0,1) × [0,1) の正方形。画素中心 (0.5, 0.5) だけが内側で、画素 (1,0) は外。
        List<Run> runs = PolygonRasterizer.runsFor(
                poly(new double[] { 0, 1, 1, 0 }, new double[] { 0, 0, 1, 1 }), 8, 8, 0);
        assertEquals(Set.of("0,0"), painted(runs), "画素中心の偶奇則（frontend と同じ規約）");
    }

    @Test
    void dilation_expandsByRequestedPixels() {
        List<Run> none = PolygonRasterizer.runsFor(
                poly(new double[] { 10, 12, 12, 10 }, new double[] { 10, 10, 12, 12 }), 32, 32, 0);
        List<Run> two = PolygonRasterizer.runsFor(
                poly(new double[] { 10, 12, 12, 10 }, new double[] { 10, 10, 12, 12 }), 32, 32, 2);
        assertEquals(4, painted(none).size(), "膨張なしは 2x2");
        assertEquals(36, painted(two).size(), "2px 膨張で 6x6（脱識別は広めに塗るのが安全側）");
        assertTrue(isPainted(two, 8, 8), "外側 2px まで広がる");
        assertFalse(isPainted(two, 7, 7), "3px 先までは広がらない");
    }

    @Test
    void dilation_isClampedToMaximum() {
        List<Run> huge = PolygonRasterizer.runsFor(
                poly(new double[] { 50, 52, 52, 50 }, new double[] { 50, 50, 52, 52 }), 128, 128, 999);
        int side = 2 + 2 * PolygonRasterizer.MAX_DILATE_PX;
        assertEquals(side * side, painted(huge).size(), "膨張量は上限で頭打ち");
    }

    @Test
    void clipsToImageBounds() {
        // 画像からはみ出す矩形。はみ出したぶんは落ちるが、内側は塗られる。
        List<Run> runs = PolygonRasterizer.runsFor(
                poly(new double[] { -5, 5, 5, -5 }, new double[] { -5, -5, 5, 5 }), 10, 10, 0);
        assertTrue(isPainted(runs, 0, 0), "画像内は塗る");
        assertTrue(isPainted(runs, 4, 4), "画像内は塗る");
        for (Run r : runs) {
            assertTrue(r.y() >= 0 && r.y() < 10, "行が画像内");
            assertTrue(r.xStart() >= 0 && r.xEnd() <= 10, "列が画像内");
        }
    }

    @Test
    void dilationNearImageEdge_doesNotOverflow() {
        List<Run> runs = PolygonRasterizer.runsFor(
                poly(new double[] { 0, 2, 2, 0 }, new double[] { 0, 0, 2, 2 }), 10, 10, 3);
        for (Run r : runs) {
            assertTrue(r.y() >= 0 && r.y() < 10);
            assertTrue(r.xStart() >= 0 && r.xEnd() <= 10);
        }
        assertTrue(isPainted(runs, 4, 4), "画像内の膨張は効く");
    }

    // ------------------------------------------------------------------------
    // 壊れた入力は「塗らない」（＝申告もされない）
    // ------------------------------------------------------------------------

    @Test
    void subPixelVertices_areAccepted() {
        // frontend は頂点をサブピクセル float で送る。丸めると 1px ずれるので丸めない。
        List<Run> runs = PolygonRasterizer.runsFor(
                poly(new double[] { 0.5, 10.25, 5.75 }, new double[] { 0.5, 2.5, 12.125 }), 32, 32, 0);
        assertFalse(runs.isEmpty(), "サブピクセル頂点でも塗れる");
    }

    @Test
    void fewerThanThreeVertices_paintNothing() {
        assertTrue(PolygonRasterizer.runsFor(
                poly(new double[] { 0, 5 }, new double[] { 0, 5 }), 32, 32, 0).isEmpty(),
                "面積を持たない入力は塗らない");
    }

    @Test
    void nonFiniteCoordinates_paintNothing() {
        assertTrue(PolygonRasterizer.runsFor(
                poly(new double[] { 0, Double.NaN, 5 }, new double[] { 0, 5, 5 }), 32, 32, 0).isEmpty(),
                "NaN があると「どこを塗るべきか分からない」ので何もしない");
        assertTrue(PolygonRasterizer.runsFor(
                poly(new double[] { 0, Double.POSITIVE_INFINITY, 5 }, new double[] { 0, 5, 5 }), 32, 32, 0)
                .isEmpty(), "Infinity も同様");
    }

    @Test
    void mismatchedOrNullArrays_paintNothing() {
        assertTrue(PolygonRasterizer.runsFor(
                poly(new double[] { 0, 1, 2 }, new double[] { 0, 1 }), 32, 32, 0).isEmpty());
        assertTrue(PolygonRasterizer.runsFor(poly(null, null), 32, 32, 0).isEmpty());
        assertTrue(PolygonRasterizer.runsFor(null, 32, 32, 0).isEmpty());
    }

    @Test
    void zeroSizedImage_paintsNothing() {
        assertTrue(PolygonRasterizer.runsFor(
                poly(new double[] { 0, 5, 5 }, new double[] { 0, 0, 5 }), 0, 0, 0).isEmpty());
    }

    @Test
    void polygonEntirelyOutsideImage_paintsNothing() {
        assertTrue(PolygonRasterizer.runsFor(
                poly(new double[] { 100, 110, 110 }, new double[] { 100, 100, 110 }), 32, 32, 0).isEmpty(),
                "画像外の ROI は 1 画素も塗らない（＝申告もされない）");
    }
}
