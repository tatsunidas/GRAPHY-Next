/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

/** QR ウィンドウの SERIES 行（リモート PACS への SERIES レベル C-FIND 結果）。 */
public record QrSeriesRow(
        String seriesInstanceUid,
        String modality,
        Integer seriesNumber,
        String seriesDescription,
        String protocolName,
        int numberOfSeriesRelatedInstances) {
}
