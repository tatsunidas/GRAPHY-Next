/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import ij.gui.OvalRoi;
import ij.gui.PolygonRoi;
import ij.gui.Roi;
import ij.process.ImageProcessor;
import org.junit.jupiter.api.Test;

import java.awt.Rectangle;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * spike: ImageJ の {@code Roi.getMask()} / {@code getBounds()} が<b>ヘッドレスで</b>使えるかの確認。
 *
 * <p>焼き込みマスクを任意の閉じた ROI（矩形・楕円・ポリゴン・クローズドフリーハンド）に広げる際、
 * 形状 → 画素の判定を ImageJ に任せられるかがこれで決まる。ImageJ は一部 API が AWT/Display を
 * 要求し、このリポジトリにも前例がある（i18n の {@code viewer2d.imagej.bridgeFailed}）。
 *
 * <p>ここが通れば、<b>画素の書き込みは現行の {@code byte[]} 直書きのまま</b>にでき、
 * ビット深度・signed・RGB・エンディアンの往復（＝旧 GRAPHY が必要としていた再エンコード層）を
 * 持ち込まずに済む。通らなければ {@code java.awt.geom.Path2D} + {@code Area} で自前ラスタ化する。
 */
class IjRoiMaskSpikeTest {

    @Test
    void rectRoi_returnsNullMask_meaningWholeBoundingBox() {
        Roi r = new Roi(3, 4, 10, 6);
        assertEquals(new Rectangle(3, 4, 10, 6), r.getBounds());
        // 矩形は「bbox 全体が対象」なので getMask() は null を返す仕様。
        assertNull(r.getMask(), "矩形 ROI は null（＝bbox 全体）");
    }

    @Test
    void ovalRoi_hasMask_thatExcludesCorners() {
        OvalRoi r = new OvalRoi(0, 0, 20, 20);
        ImageProcessor m = r.getMask();
        assertNotNull(m, "楕円はマスクを返す");
        assertEquals(20, m.getWidth());
        assertEquals(20, m.getHeight());
        assertTrue(m.get(10, 10) != 0, "中心は内側");
        assertFalse(m.get(0, 0) != 0, "bbox の四隅は外側（＝矩形近似ではない）");
        assertFalse(m.get(19, 19) != 0, "bbox の四隅は外側");
    }

    @Test
    void polygonRoi_hasMask_forConcaveShape() {
        // コの字（凹）。走査線の実装ミスがあれば凹部が埋まる。
        float[] xs = { 0, 30, 30, 10, 10, 30, 30, 0 };
        float[] ys = { 0, 0, 10, 10, 20, 20, 30, 30 };
        PolygonRoi r = new PolygonRoi(xs, ys, xs.length, Roi.POLYGON);
        ImageProcessor m = r.getMask();
        assertNotNull(m, "ポリゴンはマスクを返す");
        assertTrue(m.get(5, 15) != 0, "左の縦棒は内側");
        assertFalse(m.get(20, 15) != 0, "凹部は外側（埋まらない）");
    }

    @Test
    void freehandRoi_isTreatedAsClosedArea() {
        float[] xs = { 0, 20, 20, 0 };
        float[] ys = { 0, 0, 20, 20 };
        PolygonRoi r = new PolygonRoi(xs, ys, xs.length, Roi.FREEROI);
        assertNotNull(r.getMask(), "FREEROI も閉じた領域としてマスクを返す");
        assertTrue(r.getMask().get(10, 10) != 0);
    }

    @Test
    void openRoiTypes_produceNoArea() {
        // polyline / point / angle は面積を持たない＝焼き込みには使えない。
        float[] xs = { 0, 20 };
        float[] ys = { 0, 20 };
        PolygonRoi line = new PolygonRoi(xs, ys, xs.length, Roi.POLYLINE);
        assertFalse(line.isArea(), "polyline は面ではない");
    }

    @Test
    void subPixelVertices_areAccepted() {
        // annotationToImageJDto は頂点をサブピクセル float で返すので、丸めずに渡せること。
        float[] xs = { 0.5f, 10.25f, 5.75f };
        float[] ys = { 0.5f, 2.5f, 12.125f };
        PolygonRoi r = new PolygonRoi(xs, ys, xs.length, Roi.POLYGON);
        assertNotNull(r.getMask(), "サブピクセル頂点でもマスクが得られる");
    }
}
