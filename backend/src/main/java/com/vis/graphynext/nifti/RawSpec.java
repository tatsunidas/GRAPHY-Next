/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import java.nio.ByteOrder;
import java.util.Locale;

/**
 * Raw データ（ヘッダの無い画素配列）の読み方。利用者が申告した寸法・型・バイト順・読み飛ばし・幾何を持つ
 * （fw/nifti-import.md「Raw データ」）。
 *
 * @param type        uint8 / int8 / uint16 / int16 / uint32 / int32 / float32 / float64
 * @param byteOrder   little / big（1 バイトの型では意味を持たない）
 * @param offset      先頭の読み飛ばしバイト数
 * @param spacing     {x, y, z} mm
 * @param orientation axial / coronal / sagittal
 * @param origin      先頭画素の中心の位置（LPS mm）。null なら原点
 */
public record RawSpec(int width, int height, int slices, int phases, String type, String byteOrder, long offset,
                      double[] spacing, String orientation, double[] origin) {

    /** 申告の誤り（寸法・型・向きなど）。 */
    public static final class InvalidSpec extends IllegalArgumentException {
        InvalidSpec(String message) {
            super(message);
        }
    }

    public int datatype() {
        return switch (lower(type)) {
            case "uint8" -> NiftiHeader.DT_UINT8;
            case "int8" -> NiftiHeader.DT_INT8;
            case "uint16" -> NiftiHeader.DT_UINT16;
            case "int16" -> NiftiHeader.DT_INT16;
            case "uint32" -> NiftiHeader.DT_UINT32;
            case "int32" -> NiftiHeader.DT_INT32;
            case "float32" -> NiftiHeader.DT_FLOAT32;
            case "float64" -> NiftiHeader.DT_FLOAT64;
            default -> throw new InvalidSpec("型が分かりません: " + type);
        };
    }

    public int bytesPerVoxel() {
        return switch (datatype()) {
            case NiftiHeader.DT_UINT8, NiftiHeader.DT_INT8 -> 1;
            case NiftiHeader.DT_UINT16, NiftiHeader.DT_INT16 -> 2;
            case NiftiHeader.DT_FLOAT64 -> 8;
            default -> 4;
        };
    }

    public ByteOrder order() {
        return switch (lower(byteOrder)) {
            case "", "little" -> ByteOrder.LITTLE_ENDIAN;
            case "big" -> ByteOrder.BIG_ENDIAN;
            default -> throw new InvalidSpec("バイト順が分かりません: " + byteOrder);
        };
    }

    /** 画素を読むのに要るバイト数（読み飛ばし＋幅×高さ×枚数×時相×型の大きさ）。 */
    public long requiredBytes() {
        validate();
        return offset + (long) width * height * slices * Math.max(1, phases) * bytesPerVoxel();
    }

    /** 行方向・列方向の単位ベクトル（LPS）。 */
    double[][] axes() {
        return switch (lower(orientation)) {
            case "", "axial" -> new double[][] { { 1, 0, 0 }, { 0, 1, 0 } };
            case "coronal" -> new double[][] { { 1, 0, 0 }, { 0, 0, -1 } };
            case "sagittal" -> new double[][] { { 0, 1, 0 }, { 0, 0, -1 } };
            default -> throw new InvalidSpec("向きが分かりません: " + orientation);
        };
    }

    public NiftiHeader toHeader() {
        validate();
        double[][] ax = axes();
        double[] o = origin == null ? new double[] { 0, 0, 0 } : origin;
        return NiftiHeader.raw(width, height, slices, Math.max(1, phases), datatype(), order(), offset,
                spacing, ax[0], ax[1], o);
    }

    void validate() {
        if (width < 1 || height < 1 || slices < 1 || phases < 0) {
            throw new InvalidSpec("幅・高さ・枚数は 1 以上にしてください");
        }
        if (offset < 0) {
            throw new InvalidSpec("読み飛ばしは 0 以上にしてください");
        }
        if (spacing == null || spacing.length != 3) {
            throw new InvalidSpec("画素間隔は x・y・z の 3 つが要ります");
        }
        for (double s : spacing) {
            if (!(s > 0) || !Double.isFinite(s)) {
                throw new InvalidSpec("画素間隔は正の数にしてください");
            }
        }
        if (origin != null && (origin.length != 3 || !Double.isFinite(origin[0]) || !Double.isFinite(origin[1])
                || !Double.isFinite(origin[2]))) {
            throw new InvalidSpec("原点は x・y・z の 3 つの数にしてください");
        }
        datatype();
        order();
        axes();
    }

    private static String lower(String s) {
        return s == null ? "" : s.trim().toLowerCase(Locale.ROOT);
    }
}
