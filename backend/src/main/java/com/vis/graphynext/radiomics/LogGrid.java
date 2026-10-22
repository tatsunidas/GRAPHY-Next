/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import ij.measure.Calibration;

/**
 * LoG の格子の前提。LoG は画素ごとの値が間隔に依るので、等方でない格子は断る（RadiomicsJ も断るが、メッセージが
 * 英語で、3D と 2D のどちらで落ちたかも分からない）。3D は 3 軸、2D（面内）は面内の 2 軸が揃っていること。
 */
final class LogGrid {

    private LogGrid() {
    }

    static void require(Calibration c, boolean volumeFilter) {
        boolean inPlane = Math.abs(c.pixelWidth - c.pixelHeight) <= 1e-3 * Math.max(c.pixelWidth, c.pixelHeight);
        boolean volume = inPlane && Math.abs(c.pixelWidth - c.pixelDepth) <= 1e-3 * Math.max(c.pixelWidth, c.pixelDepth);
        if (volumeFilter ? !volume : !inPlane) {
            throw new IllegalArgumentException(String.format(
                    "LoG フィルタは等方の格子が前提です（この画像は %.3f × %.3f × %.3f mm）。"
                            + "先にリサンプリングを指定してください。", c.pixelWidth, c.pixelHeight, c.pixelDepth));
        }
    }
}
