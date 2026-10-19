/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import static org.assertj.core.api.Assertions.assertThat;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;

import javax.imageio.ImageIO;

import org.junit.jupiter.api.Test;

/** Raw の中央スライスのプレビュー。既知の模様が PNG の同じ場所に出ること、申告を誤ると崩れること。 */
class RawPreviewTest {

    private static final int NX = 40;
    private static final int NY = 30;
    private static final int NZ = 5;

    /** 中央のスライス（z=2）だけ左上の 1/4 が 1000、他は 0。ほかのスライスは全面 −500。 */
    private static Path pattern(ByteOrder order) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(16 + NX * NY * NZ * 2).order(order);
        b.position(16);
        for (int z = 0; z < NZ; z++) {
            for (int y = 0; y < NY; y++) {
                for (int x = 0; x < NX; x++) {
                    short v = z == NZ / 2 ? (short) (x < NX / 2 && y < NY / 2 ? 1000 : 0) : (short) -500;
                    b.putShort(v);
                }
            }
        }
        Path f = Files.createTempFile("raw", ".raw");
        Files.write(f, b.array());
        return f;
    }

    private static RawSpec spec(String order) {
        return new RawSpec(NX, NY, NZ, 1, "int16", order, 16, new double[] { 1, 1, 1 }, "axial", null);
    }

    private static int gray(BufferedImage img, int x, int y) {
        return img.getRaster().getSample(x, y, 0);
    }

    @Test
    void 中央スライスの左上だけが明るく出る() throws IOException {
        RawPreview.Result r = RawPreview.middleSlice(pattern(ByteOrder.LITTLE_ENDIAN), spec("little"));
        BufferedImage img = ImageIO.read(new ByteArrayInputStream(r.png()));
        assertThat(img.getWidth()).isEqualTo(NX);
        assertThat(img.getHeight()).isEqualTo(NY);
        assertThat(r.slice()).isEqualTo(2);
        assertThat(r.min()).isEqualTo(0.0);
        assertThat(r.max()).isEqualTo(1000.0);
        assertThat(gray(img, 1, 1)).isEqualTo(255);
        assertThat(gray(img, NX / 2 - 1, NY / 2 - 1)).isEqualTo(255);
        assertThat(gray(img, NX - 2, 1)).isZero();
        assertThat(gray(img, 1, NY - 2)).isZero();
        assertThat(gray(img, NX - 2, NY - 2)).isZero();
    }

    @Test
    void バイト順を誤ると模様が崩れる() throws IOException {
        RawPreview.Result r = RawPreview.middleSlice(pattern(ByteOrder.LITTLE_ENDIAN), spec("big"));
        BufferedImage img = ImageIO.read(new ByteArrayInputStream(r.png()));
        // 1000（0x03E8）をビッグで読むと 0xE803＝−6141。左上が最も暗くなる（正しい申告と逆）
        assertThat(r.min()).isEqualTo(-6141.0);
        assertThat(gray(img, 1, 1)).isNotEqualTo(255);
    }

    @Test
    void 一様なスライスは中間の灰色() throws IOException {
        Path f = Files.createTempFile("raw", ".raw");
        Files.write(f, new byte[4 * 4 * 1]);
        RawPreview.Result r = RawPreview.middleSlice(f, new RawSpec(4, 4, 1, 1, "uint8", "little", 0, new double[] { 1, 1, 1 }, "axial", null));
        BufferedImage img = ImageIO.read(new ByteArrayInputStream(r.png()));
        assertThat(gray(img, 2, 2)).isEqualTo(128);
    }
}
