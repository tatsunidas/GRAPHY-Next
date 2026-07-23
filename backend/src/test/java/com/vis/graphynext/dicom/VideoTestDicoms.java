/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * テスト用に encapsulated video DICOM（Part-10）を合成するヘルパ。
 * ピクセルはデコードされないので、フラグメント本体は任意のバイト列でよい
 * （{@link com.vis.graphynext.nondicom.VideoConverter#writeEncapsulated} と同じ書式）。
 */
final class VideoTestDicoms {

    private VideoTestDicoms() {}

    /**
     * 指定転送構文の Video Photographic DICOM を temp に書き出す。fragments を BOT の後ろに順に格納する。
     * 各フラグメントは偶数長になるよう必要なら 0 パディングする（DICOM 規約）。
     */
    static Path writeVideoDicom(Path dir, String tsuid, int rows, int cols, int frames,
                                double frameTimeMs, byte[]... fragments) throws IOException {
        Attributes attrs = new Attributes();
        attrs.setString(Tag.SOPClassUID, VR.UI, UID.VideoPhotographicImageStorage);
        attrs.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.StudyInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.Modality, VR.CS, "XC");
        attrs.setInt(Tag.Rows, VR.US, rows);
        attrs.setInt(Tag.Columns, VR.US, cols);
        attrs.setInt(Tag.NumberOfFrames, VR.IS, frames);
        attrs.setDouble(Tag.FrameTime, VR.DS, frameTimeMs);

        Path out = Files.createTempFile(dir, "test-video-", ".dcm");
        Attributes fmi = attrs.createFileMetaInformation(tsuid);
        try (DicomOutputStream dos = new DicomOutputStream(out.toFile())) {
            dos.writeDataset(fmi, attrs);
            dos.writeHeader(Tag.PixelData, VR.OB, -1); // undefined length = encapsulated
            dos.writeHeader(Tag.Item, null, 0);        // 空の Basic Offset Table
            for (byte[] f : fragments) {
                boolean odd = (f.length & 1) != 0;
                int itemLen = odd ? f.length + 1 : f.length;
                dos.writeHeader(Tag.Item, null, itemLen);
                dos.write(f);
                if (odd) {
                    dos.write(0);
                }
            }
            dos.writeHeader(Tag.SequenceDelimitationItem, null, 0);
        }
        return out;
    }
}
