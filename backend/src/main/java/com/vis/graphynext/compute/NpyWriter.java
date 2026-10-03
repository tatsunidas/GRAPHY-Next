/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * NumPy の {@code .npy}（形式 1.0）を書く。npz はこれを ZIP に入れたもの（{@code numpy.load} がそのまま読む）。
 *
 * <p>本体に npy / npz / NIfTI の書き手は無かったので足した（NIfTI は読み込み専用の {@code nifti} パッケージだけ）。
 * 書くのは C 順・リトルエンディアンだけ。
 */
final class NpyWriter {

    private static final byte[] MAGIC = {(byte) 0x93, 'N', 'U', 'M', 'P', 'Y', 1, 0};

    private NpyWriter() {
    }

    /** ヘッダを書く。続けて呼び出し側が {@code shape} の積 × 要素サイズのバイトを書く。 */
    static void writeHeader(OutputStream out, String descr, long... shape) throws IOException {
        StringBuilder s = new StringBuilder("(");
        for (int i = 0; i < shape.length; i++) {
            s.append(shape[i]);
            if (shape.length == 1 || i < shape.length - 1) {
                s.append(", ");
            }
        }
        s.append(")");
        String dict = "{'descr': '" + descr + "', 'fortran_order': False, 'shape': " + s + ", }";
        // 魔法数 8 + 長さ 2 + 辞書 + 改行 が 64 の倍数になるよう空白で埋める
        int unpadded = MAGIC.length + 2 + dict.length() + 1;
        int pad = (64 - unpadded % 64) % 64;
        String header = dict + " ".repeat(pad) + "\n";
        out.write(MAGIC);
        int len = header.length();
        out.write(len & 0xff);
        out.write((len >> 8) & 0xff);
        out.write(header.getBytes(StandardCharsets.US_ASCII));
    }

    static void writeFloat64(OutputStream out, double[] values, long... shape) throws IOException {
        writeHeader(out, "<f8", shape);
        ByteBuffer b = ByteBuffer.allocate(values.length * 8).order(ByteOrder.LITTLE_ENDIAN);
        for (double v : values) {
            b.putDouble(v);
        }
        out.write(b.array());
    }
}
