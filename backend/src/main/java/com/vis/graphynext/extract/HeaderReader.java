/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;

import java.io.IOException;
import java.nio.file.Path;

/**
 * DICOM ファイルのヘッダ（画素データの手前まで）を読む。{@link TagExtractService} と
 * {@link ListColumnService} が同じ読み方をそろえるための部品。
 */
final class HeaderReader {

    private HeaderReader() {
    }

    /** ヘッダを読む。読めなければ {@link IOException}（呼び出し側が理由を区別して扱う）。 */
    static Attributes read(Path path) throws IOException {
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDatasetUntilPixelData();
        }
    }
}
