/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

/**
 * シリーズ一覧の 1 行（standalone=H2 / web=QIDO 共通）。
 */
public record SeriesDto(String seriesInstanceUid, String modality, Integer seriesNumber,
                        String seriesDescription, String sopClassUid, long numberOfInstances,
                        Long numberOfFrames) {

    /** フレーム数が分からない経路向け（QR・web など。{@code numberOfFrames} は null＝不明）。 */
    public SeriesDto(String seriesInstanceUid, String modality, Integer seriesNumber,
                     String seriesDescription, String sopClassUid, long numberOfInstances) {
        this(seriesInstanceUid, modality, seriesNumber, seriesDescription, sopClassUid, numberOfInstances, null);
    }
}
