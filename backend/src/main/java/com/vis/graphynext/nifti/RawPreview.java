/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Raw の中央のスライス（時相 1）を PNG にする（fw/nifti-import.md §8「プレビュー」）。取り込む前に、
 * 型・バイト順・寸法の誤りを画像で見つけるためのもの。並びは保管と同じ（行 0 が上、列 0 が左）。
 *
 * <p>濃淡は、そのスライスの有限値の最小〜最大を 0〜255 に割り当てる。誤った申告でも何かが見える
 * （固定の窓だと全面が白や黒に潰れて、誤りの形が読めない）。
 */
public final class RawPreview {

    /**
     * @param min   有限値の最小（有限値が無ければ NaN）
     * @param max   有限値の最大
     * @param slice 0 始まりのスライス番号
     */
    public record Result(byte[] png, double min, double max, int slice) {
    }

    private RawPreview() {
    }

    public static Result middleSlice(Path file, RawSpec spec) throws IOException {
        int nx = spec.width();
        int ny = spec.height();
        int z = spec.slices() / 2;
        int bpv = spec.bytesPerVoxel();
        long frameBytes = (long) nx * ny * bpv;
        if (frameBytes > Integer.MAX_VALUE) {
            throw new IOException("1 フレームが大きすぎます: " + frameBytes + " バイト");
        }
        long start = spec.offset() + frameBytes * z;
        byte[] raw;
        try (InputStream in = Files.newInputStream(file)) {
            in.skipNBytes(start);
            raw = in.readNBytes((int) frameBytes);
        }
        if (raw.length < frameBytes) {
            throw new IOException("画素がファイルに足りません（スライス " + z + "）");
        }
        double[] v = decode(raw, spec, nx * ny);
        double min = Double.POSITIVE_INFINITY;
        double max = Double.NEGATIVE_INFINITY;
        for (double d : v) {
            if (Double.isFinite(d)) {
                min = Math.min(min, d);
                max = Math.max(max, d);
            }
        }
        BufferedImage img = new BufferedImage(nx, ny, BufferedImage.TYPE_BYTE_GRAY);
        byte[] out = ((java.awt.image.DataBufferByte) img.getRaster().getDataBuffer()).getData();
        boolean any = min <= max;
        double range = any ? max - min : 0;
        for (int i = 0; i < v.length; i++) {
            double d = v[i];
            int g;
            if (!any || !Double.isFinite(d)) {
                g = 0;
            } else if (range == 0) {
                g = 128; // 一様な値（全面同じ）は中間の灰色で出す
            } else {
                g = (int) Math.round((d - min) / range * 255);
            }
            out[i] = (byte) g;
        }
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        ImageIO.write(img, "png", png);
        return new Result(png.toByteArray(), any ? min : Double.NaN, any ? max : Double.NaN, z);
    }

    static double[] decode(byte[] raw, RawSpec spec, int n) {
        ByteBuffer b = ByteBuffer.wrap(raw).order(spec.order());
        double[] v = new double[n];
        switch (spec.datatype()) {
            case NiftiHeader.DT_UINT8 -> {
                for (int i = 0; i < n; i++) v[i] = raw[i] & 0xFF;
            }
            case NiftiHeader.DT_INT8 -> {
                for (int i = 0; i < n; i++) v[i] = raw[i];
            }
            case NiftiHeader.DT_UINT16 -> {
                for (int i = 0; i < n; i++) v[i] = b.getShort(i * 2) & 0xFFFF;
            }
            case NiftiHeader.DT_INT16 -> {
                for (int i = 0; i < n; i++) v[i] = b.getShort(i * 2);
            }
            case NiftiHeader.DT_UINT32 -> {
                for (int i = 0; i < n; i++) v[i] = b.getInt(i * 4) & 0xFFFFFFFFL;
            }
            case NiftiHeader.DT_INT32 -> {
                for (int i = 0; i < n; i++) v[i] = b.getInt(i * 4);
            }
            case NiftiHeader.DT_FLOAT32 -> {
                for (int i = 0; i < n; i++) v[i] = b.getFloat(i * 4);
            }
            default -> {
                for (int i = 0; i < n; i++) v[i] = b.getDouble(i * 8);
            }
        }
        return v;
    }
}
