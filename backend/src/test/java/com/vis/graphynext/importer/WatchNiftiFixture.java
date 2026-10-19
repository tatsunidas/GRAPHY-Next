/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.GZIPOutputStream;

/** 監視取り込みの試験用の合成 NIfTI-1（int16、{@code NX×NY×NZ}、間隔 {@code DX・DY・DZ} mm）。 */
public final class WatchNiftiFixture {

    public static final int NX = 6;
    public static final int NY = 5;
    public static final int NZ = 4;
    public static final double DX = 2.0; // 列方向の間隔
    public static final double DY = 3.0; // 行方向の間隔
    public static final double DZ = 5.0;

    private WatchNiftiFixture() {
    }

    /** ファイル名が {@code .gz} で終われば gzip で書く。 */
    public static Path write(Path file, int seed) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(352 + NX * NY * NZ * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(0, 348);
        b.putShort(40, (short) 3);
        b.putShort(42, (short) NX);
        b.putShort(44, (short) NY);
        b.putShort(46, (short) NZ);
        b.putShort(48, (short) 1);
        b.putShort(50, (short) 1);
        b.putShort(70, (short) 4); // DT_INT16
        b.putShort(72, (short) 16);
        float[] pixdim = { 1, (float) DX, (float) DY, (float) DZ, 0, 0, 0, 0 };
        for (int i = 0; i < 8; i++) {
            b.putFloat(76 + i * 4, pixdim[i]);
        }
        b.putFloat(108, 352f);
        b.putFloat(112, 1f);
        b.put(123, (byte) 2);
        b.putShort(254, (short) 1);
        float[][] srow = { { (float) DX, 0, 0, 10 }, { 0, (float) DY, 0, 20 }, { 0, 0, (float) DZ, 30 } };
        for (int r = 0; r < 3; r++) {
            for (int i = 0; i < 4; i++) {
                b.putFloat(280 + r * 16 + i * 4, srow[r][i]);
            }
        }
        b.position(352);
        for (int i = 0; i < NX * NY * NZ; i++) {
            b.putShort((short) (seed + i));
        }
        Files.createDirectories(file.getParent());
        if (file.getFileName().toString().endsWith(".gz")) {
            try (OutputStream o = new GZIPOutputStream(Files.newOutputStream(file))) {
                o.write(b.array());
            }
        } else {
            Files.write(file, b.array());
        }
        return file;
    }
}
