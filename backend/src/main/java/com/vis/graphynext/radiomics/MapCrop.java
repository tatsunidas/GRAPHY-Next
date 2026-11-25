/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.FloatProcessor;
import ij.process.ImageProcessor;

/**
 * マスクつきのテクスチャマップで、RadiomicsJ に渡すボリュームを 1 枚ごとに ROI の周りへ切り出す。
 *
 * <p>RadiomicsJ の {@code generateFeatureMap} は、余白（margin）が正だと呼ぶたびに全ボリュームのマスクを
 * 膨張させる（1 枚あたり全画素 × (2m+1)^3 近傍）。全身 PET（200x200x462）では 1 枚約 6 秒のほぼ全部がここ
 * だった。窓の値に効くのは ROI の周りだけなので、その範囲だけを渡せば出力は全画素一致する。
 *
 * <p>切り出し範囲は、スライス z について（g = 余白 + カーネル半径）:
 * <ul>
 *   <li>窓は ROI 画素から半径 r、窓の中の膨張マスクは元マスクから余白 m。よって z（3D は z±g）のマスクの外接箱の
 *       ±g が窓の読む範囲。</li>
 *   <li>RadiomicsJ は ROI が画像の縁から余白以内にあると画像を延長して計算を変える（roiReachesTheBorder）。
 *       切り出した画像の縁にそれが起きないよう、切り出しは外接箱の ±(g+m) とし、z±g の外のマスクは 0 にする。
 *       画像の縁で切れる所は元の画像の縁なので、全体で縁にかからないことが保証されていれば同じ。</li>
 *   <li>出力の格子は元の画像の原点から stride おき。切り出しの原点を stride の倍数に切り下げて揃える。</li>
 * </ul>
 * 全体で縁にかかる（{@link #reachesBorder}）ときは切り出さない（{@link #fallbackReason}）。
 */
final class MapCrop {

    /** 切り出した範囲（両端を含む）。 */
    record Region(int x0, int x1, int y0, int y1, int z0, int z1, int keepLo, int keepHi) {
        int width() { return x1 - x0 + 1; }
        int height() { return y1 - y0 + 1; }
        int depth() { return z1 - z0 + 1; }
    }

    private final int w, h, s, margin, radius, stride;
    private final boolean d2;
    /** スライスごとのマスクの外接箱 {xmin, xmax, ymin, ymax}。マスクの無いスライスは null。 */
    private final int[][] box;
    private final String fallbackReason;
    private final int[] total; // 全体の外接箱 {x0,x1,y0,y1,z0,z1}

    private MapCrop(int w, int h, int s, int margin, int radius, int stride, boolean d2, int[][] box) {
        this.w = w; this.h = h; this.s = s;
        this.margin = margin; this.radius = radius; this.stride = stride; this.d2 = d2;
        this.box = box;
        int[] t = {Integer.MAX_VALUE, -1, Integer.MAX_VALUE, -1, Integer.MAX_VALUE, -1};
        for (int z = 0; z < s; z++) {
            if (box[z] == null) continue;
            t[0] = Math.min(t[0], box[z][0]); t[1] = Math.max(t[1], box[z][1]);
            t[2] = Math.min(t[2], box[z][2]); t[3] = Math.max(t[3], box[z][3]);
            t[4] = Math.min(t[4], z); t[5] = Math.max(t[5], z);
        }
        this.total = t;
        if (t[5] < 0) {
            fallbackReason = "mask is empty";
        } else if (margin > 0 && reachesBorder(box, w, h, s, margin, d2)) {
            fallbackReason = "ROI is within the margin (" + margin + ") of the image border (RadiomicsJ pads the image there)";
        } else {
            fallbackReason = null;
        }
    }

    static MapCrop plan(ImagePlus mask, int margin, int filterSize, boolean d2, int stride) {
        int w = mask.getWidth(), h = mask.getHeight(), s = mask.getNSlices();
        int[][] box = new int[s][];
        ImageStack st = mask.getStack();
        for (int z = 0; z < s; z++) {
            FloatProcessor ip = st.getProcessor(z + 1).convertToFloatProcessor();
            float[] px = (float[]) ip.getPixels();
            int x0 = w, x1 = -1, y0 = h, y1 = -1;
            for (int y = 0; y < h; y++) {
                int row = y * w;
                for (int x = 0; x < w; x++) {
                    if (px[row + x] >= 1) {
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                }
            }
            if (x1 >= 0) box[z] = new int[]{x0, x1, y0, y1};
        }
        return new MapCrop(w, h, s, margin, filterSize / 2, Math.max(1, stride), d2, box);
    }

    /**
     * RadiomicsJ の {@code roiReachesTheBorder} と同じ規則: ROI 画素が 1 つでも、x・y（3D は z も）で
     * 画像の縁から margin 画素以内にあれば真。外接箱の端は ROI 画素そのものなので、箱で判定して同じ。
     */
    static boolean reachesBorder(int[][] box, int w, int h, int s, int margin, boolean d2) {
        for (int z = 0; z < s; z++) {
            int[] b = box[z];
            if (b == null) continue;
            boolean nearInZ = !d2 && (z < margin || z >= s - margin);
            if (nearInZ || b[0] < margin || b[1] >= w - margin || b[2] < margin || b[3] >= h - margin) {
                return true;
            }
        }
        return false;
    }

    /** null なら切り出せる。 */
    String fallbackReason() { return fallbackReason; }

    /** スライス z にマスクが無い（出力は全部 0 になる）。 */
    boolean emptySlice(int z) { return box[z] == null; }

    /** 全体の外接箱と元の大きさの説明（ログ用）。 */
    String describe() {
        return "ROI bbox [" + total[0] + ".." + total[1] + "]x[" + total[2] + ".." + total[3] + "]x[" + total[4] + ".." + total[5]
                + "] + " + (2 * margin + radius) + " per slice (full " + w + "x" + h + "x" + s + ")";
    }

    /** スライス z（0 始まり）の切り出し範囲。マスクの無いスライスでは呼ばない。 */
    Region region(int z) {
        int g = margin + radius;
        int keepLo = d2 ? z : Math.max(0, z - g);
        int keepHi = d2 ? z : Math.min(s - 1, z + g);
        int bx0 = Integer.MAX_VALUE, bx1 = -1, by0 = Integer.MAX_VALUE, by1 = -1;
        for (int k = keepLo; k <= keepHi; k++) {
            if (box[k] == null) continue;
            bx0 = Math.min(bx0, box[k][0]); bx1 = Math.max(bx1, box[k][1]);
            by0 = Math.min(by0, box[k][2]); by1 = Math.max(by1, box[k][3]);
        }
        int pad = g + margin;
        int x0 = Math.max(0, bx0 - pad) / stride * stride;
        int y0 = Math.max(0, by0 - pad) / stride * stride;
        int x1 = Math.min(w - 1, bx1 + pad);
        int y1 = Math.min(h - 1, by1 + pad);
        int z0 = d2 ? z : Math.max(0, z - pad);
        int z1 = d2 ? z : Math.min(s - 1, z + pad);
        return new Region(x0, x1, y0, y1, z0, z1, keepLo, keepHi);
    }

    /** 画像の切り出し（校正は元のまま）。 */
    static ImagePlus cropImage(ImagePlus img, Region r) {
        ImageStack st = img.getStack();
        ImageStack out = new ImageStack(r.width(), r.height());
        for (int z = r.z0(); z <= r.z1(); z++) {
            out.addSlice(cut(st.getProcessor(z + 1).convertToFloatProcessor(), r));
        }
        ImagePlus c = new ImagePlus(img.getTitle() + "_crop", out);
        c.setCalibration((Calibration) img.getCalibration().copy());
        return c;
    }

    /** マスクの切り出し。keep の外のスライスは 0。 */
    static ImagePlus cropMask(ImagePlus mask, Region r) {
        ImageStack st = mask.getStack();
        ImageStack out = new ImageStack(r.width(), r.height());
        for (int z = r.z0(); z <= r.z1(); z++) {
            if (z < r.keepLo() || z > r.keepHi()) {
                out.addSlice(new FloatProcessor(r.width(), r.height()));
            } else {
                out.addSlice(cut(st.getProcessor(z + 1).convertToFloatProcessor(), r));
            }
        }
        ImagePlus c = new ImagePlus(mask.getTitle() + "_crop", out);
        c.setCalibration((Calibration) mask.getCalibration().copy());
        return c;
    }

    private static ImageProcessor cut(FloatProcessor src, Region r) {
        int w = src.getWidth();
        float[] in = (float[]) src.getPixels();
        float[] o = new float[r.width() * r.height()];
        for (int y = 0; y < r.height(); y++) {
            System.arraycopy(in, (r.y0() + y) * w + r.x0(), o, y * r.width(), r.width());
        }
        return new FloatProcessor(r.width(), r.height(), o);
    }
}
