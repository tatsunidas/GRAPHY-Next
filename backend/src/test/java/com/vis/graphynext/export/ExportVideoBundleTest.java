/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.video.VideoRenderService;
import com.vis.graphynext.nondicom.FfmpegLocator;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Export が動画を <b>再生可能な MP4</b> として媒体へ同梱すること（{@code VIDEO/{sop}.mp4}）の検証。
 *
 * <p>portable viewer は backend 非同伴（{@code file://}）で {@code /rendered} を使えないため、
 * 媒体の中に MP4 実体が要る（`fw/video-viewer-design.md` §7 / P5）。
 * ここでは ffmpeg 不要の主経路（ペイロードが既に MP4）を対象にする。変換が要る経路は
 * {@code VideoRenderServiceTest} 側で確認済み。
 */
class ExportVideoBundleTest {

    private static final String H264_HIGH_41 = "1.2.840.10008.1.2.4.102";

    /** MP4 ペイロードを 1 フラグメントに入れた encapsulated video DICOM を書く。 */
    private static String writeVideoDicom(Path out, byte[] payload) throws IOException {
        Attributes attrs = new Attributes();
        String sop = UIDUtils.createUID();
        attrs.setString(Tag.SOPClassUID, VR.UI, UID.VideoPhotographicImageStorage);
        attrs.setString(Tag.SOPInstanceUID, VR.UI, sop);
        attrs.setString(Tag.StudyInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.Modality, VR.CS, "XC");
        attrs.setInt(Tag.Rows, VR.US, 240);
        attrs.setInt(Tag.Columns, VR.US, 320);
        attrs.setInt(Tag.NumberOfFrames, VR.IS, 2);
        attrs.setDouble(Tag.FrameTime, VR.DS, 66.6);

        Attributes fmi = attrs.createFileMetaInformation(H264_HIGH_41);
        try (DicomOutputStream dos = new DicomOutputStream(out.toFile())) {
            dos.writeDataset(fmi, attrs);
            dos.writeHeader(Tag.PixelData, VR.OB, -1);
            dos.writeHeader(Tag.Item, null, 0);
            dos.writeHeader(Tag.Item, null, payload.length);
            dos.write(payload);
            dos.writeHeader(Tag.SequenceDelimitationItem, null, 0);
        }
        return sop;
    }

    /** 先頭に ftyp ボックスを持つ「MP4 らしい」バイト列（無変換経路の判定に使う）。 */
    private static byte[] fakeMp4() {
        byte[] head = {0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'};
        byte[] body = "PSEUDO-MP4-PAYLOAD--------------".getBytes(StandardCharsets.US_ASCII);
        byte[] all = new byte[head.length + body.length];
        System.arraycopy(head, 0, all, 0, head.length);
        System.arraycopy(body, 0, all, head.length, body.length);
        return all;
    }

    private static ExportService service(Path storageDir) {
        DicomProperties props = new DicomProperties();
        props.setStorageDir(storageDir.toString());
        // repo は copyPlayableVideo では使わない（ZIP 書き出しの単体検証）。
        return new ExportService(null, new VideoRenderService(new FfmpegLocator("ffmpeg", ""), props));
    }

    private static Map<String, byte[]> unzip(byte[] zipBytes) throws IOException {
        Map<String, byte[]> out = new HashMap<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zipBytes))) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                out.put(e.getName(), in.readAllBytes());
                in.closeEntry();
            }
        }
        return out;
    }

    @Test
    void bundlesPlayableMp4UnderVideoPrefix(@TempDir Path dir) throws IOException {
        byte[] payload = fakeMp4();
        Path dcm = dir.resolve("video.dcm");
        String sop = writeVideoDicom(dcm, payload);

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        boolean ok;
        try (ZipOutputStream zip = new ZipOutputStream(baos)) {
            ok = service(dir.resolve("storage")).copyPlayableVideo(zip, dcm, sop);
        }

        assertTrue(ok, "同梱できた");
        Map<String, byte[]> entries = unzip(baos.toByteArray());
        assertEquals(1, entries.size(), "エントリは 1 つ: " + entries.keySet());
        byte[] mp4 = entries.get("VIDEO/" + sop + ".mp4");
        assertTrue(mp4 != null, "VIDEO/{sop}.mp4 がある: " + entries.keySet());
        // 取込済み動画は既に MP4 なので、そのまま（バイト等価）で入る。
        assertArrayEquals(payload, mp4, "ペイロードがそのまま入る（無変換経路）");
    }

    @Test
    void skipsQuietlyWhenVideoCannotBePrepared(@TempDir Path dir) throws IOException {
        // 動画にならないファイル（DICOM ですらない）→ 例外を投げず false を返し、Export は続行できる。
        Path broken = dir.resolve("broken.dcm");
        Files.writeString(broken, "not a dicom file");

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        boolean ok;
        try (ZipOutputStream zip = new ZipOutputStream(baos)) {
            ok = service(dir.resolve("storage")).copyPlayableVideo(zip, broken, "1.2.3");
        }

        assertFalse(ok, "同梱できなかったことを返す");
        assertTrue(unzip(baos.toByteArray()).isEmpty(), "壊れたエントリを残さない");
    }
}
