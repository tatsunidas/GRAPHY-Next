/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import java.awt.geom.Path2D;
import java.awt.geom.Rectangle2D;
import java.util.ArrayList;
import java.util.List;

/**
 * 閉多角形 → 「行ごとの連続区間」への変換。焼き込み（Clean Pixel Data）の塗り範囲を決める。
 *
 * <h2>なぜ区間で返すのか</h2>
 * {@code AnonymizeService.burnInto()} の画素アドレス計算が
 * <pre>
 *   int off = base + (y * cols + x0) * bps;
 *   int len = (x1 - x0) * bps;
 *   Arrays.fill(px, off, off + len, (byte) 0);
 * </pre>
 * という「行ごとに連続領域を埋める」形になっており、矩形に依存しているのは
 * <b>{@code x0/x1/y0/y1} の決め方だけ</b>。区間列を返せば、ビット深度・{@code SamplesPerPixel}・
 * マルチフレーム・signed の扱いを<b>1 文字も変えずに</b>任意形状へ広げられる。
 *
 * <h2>🔴 判定規約: 画素中心の偶奇則</h2>
 * 画素 {@code (x, y)} は <b>{@code contains(x + 0.5, y + 0.5)}</b> で判定する。これは frontend の
 * {@code roiStats.ts} の {@code pointInPolygon} と {@code roiBooleanOps.ts} の {@code pointInPoly}
 * が使っている規約と同じ。<b>揃えないと「ROI 統計が測った領域」と「焼き込んだ領域」がズレる</b>
 * （{@code roiStats.ts} が別実装を避けたのと同じ理由）。
 *
 * <h2>なぜ ImageJ を使わないか</h2>
 * ImageJ の {@code Roi.getMask()} でも同じことはできるが、
 * <ul>
 *   <li>脱識別という中核が ImageJ 連携（{@code ImageJRoiService} / {@code net.imagej:ij}）に
 *       依存すると、ImageJ 側の都合で脱識別の正しさが動く。</li>
 *   <li>ImageJ の交換型 {@code ImageJRoiDto} は楕円・矩形を<b>軸平行 bbox</b> に潰すため、
 *       回転した楕円で<b>塗り足りなくなる</b>（焼き込み文字が残るのに気づけない）。</li>
 *   <li>{@link Path2D} は JDK 標準で<b>新規依存ゼロ</b>、{@code java.awt.geom} は Display 不要
 *       （ヘッドレス安全）、偶奇則の実装が JDK 側で保証される。</li>
 * </ul>
 *
 * <p>⚠ {@code contains()} は画素ごとの呼び出しなので走査線法より遅い。焼き込みマスクは
 * 「1 枚あたり数十×数十画素の領域が数個」なので実用上問題にならない。bbox でクリップして
 * 走査範囲を絞るのが効き、それ以上の最適化は要らない。
 */
final class PolygonRasterizer {

    /** 膨張量の上限（画素）。これ以上広げたいなら ROI 自体を大きく描くべき。 */
    static final int MAX_DILATE_PX = 8;

    /** 塗る区間。{@code y} 行の {@code [xStart, xEnd)} を埋める。 */
    record Run(int y, int xStart, int xEnd) {
    }

    private PolygonRasterizer() {
    }

    /**
     * 多角形を行区間へ落とす。
     *
     * @param dilatePx 外側へ広げる画素数。🔴 <b>既定は 0 ではなく 2 を推奨</b> ——
     *                 コストが非対称で、「塗り足りない」＝個人情報の残存＝致命的、
     *                 「塗りすぎ」＝画質劣化のみ。手描き ROI やアンチエイリアスされた
     *                 焼き込み文字の縁を確実に覆う。
     * @return 行昇順・同一行では x 昇順の区間列。1 画素も内側が無ければ空。
     */
    static List<Run> runsFor(AnonymizeMaskStore.MaskPolygon poly, int cols, int rows, int dilatePx) {
        List<Run> out = new ArrayList<>();
        if (poly == null || cols <= 0 || rows <= 0) {
            return out;
        }
        double[] xs = poly.xs();
        double[] ys = poly.ys();
        if (xs == null || ys == null || xs.length != ys.length || xs.length < 3) {
            // 3 頂点未満は面積を持たない。塗らない＝申告もしない（安全側）。
            return out;
        }
        for (int i = 0; i < xs.length; i++) {
            if (!Double.isFinite(xs[i]) || !Double.isFinite(ys[i])) {
                // 壊れた座標は「どこを塗るべきか分からない」ので何もしない。
                return out;
            }
        }
        int dilate = Math.max(0, Math.min(MAX_DILATE_PX, dilatePx));

        Path2D.Double path = new Path2D.Double(Path2D.WIND_EVEN_ODD);
        path.moveTo(xs[0], ys[0]);
        for (int i = 1; i < xs.length; i++) {
            path.lineTo(xs[i], ys[i]);
        }
        path.closePath();

        // bbox でクリップして走査範囲を絞る。膨張ぶんは走査範囲も広げておく
        // （でないと画像端に接する ROI で膨張が切れる）。
        Rectangle2D b = path.getBounds2D();
        int y0 = clamp((int) Math.floor(b.getMinY()) - dilate, 0, rows - 1);
        int y1 = clamp((int) Math.ceil(b.getMaxY()) + dilate, 0, rows - 1);
        int x0 = clamp((int) Math.floor(b.getMinX()) - dilate, 0, cols - 1);
        int x1 = clamp((int) Math.ceil(b.getMaxX()) + dilate, 0, cols - 1);
        if (y1 < y0 || x1 < x0) {
            return out;
        }

        // まず膨張なしの内外を求め、そのあとで膨らませる。
        // contains() を膨張後の各画素で呼ぶより、boolean を広げるほうが単純で速い。
        int w = x1 - x0 + 1;
        int h = y1 - y0 + 1;
        boolean[] inside = new boolean[w * h];
        for (int y = y0; y <= y1; y++) {
            for (int x = x0; x <= x1; x++) {
                if (path.contains(x + 0.5, y + 0.5)) {
                    inside[(y - y0) * w + (x - x0)] = true;
                }
            }
        }
        if (dilate > 0) {
            inside = dilate(inside, w, h, dilate);
        }

        for (int r = 0; r < h; r++) {
            int runStart = -1;
            for (int c = 0; c <= w; c++) {
                boolean on = c < w && inside[r * w + c];
                if (on && runStart < 0) {
                    runStart = c;
                } else if (!on && runStart >= 0) {
                    out.add(new Run(y0 + r, x0 + runStart, x0 + c));
                    runStart = -1;
                }
            }
        }
        return out;
    }

    /**
     * チェビシェフ距離 {@code d} で膨張（正方カーネル）。
     *
     * <p>円形カーネルにしないのは、脱識別では「広めに塗る」のが常に安全側で、
     * 角が少し余分に塗られても害が無いため。分離可能なので横・縦の 2 パスで済む。
     */
    private static boolean[] dilate(boolean[] src, int w, int h, int d) {
        boolean[] tmp = new boolean[src.length];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (!src[y * w + x]) {
                    continue;
                }
                for (int k = -d; k <= d; k++) {
                    int nx = x + k;
                    if (nx >= 0 && nx < w) {
                        tmp[y * w + nx] = true;
                    }
                }
            }
        }
        boolean[] dst = new boolean[src.length];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (!tmp[y * w + x]) {
                    continue;
                }
                for (int k = -d; k <= d; k++) {
                    int ny = y + k;
                    if (ny >= 0 && ny < h) {
                        dst[ny * w + x] = true;
                    }
                }
            }
        }
        return dst;
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }
}
