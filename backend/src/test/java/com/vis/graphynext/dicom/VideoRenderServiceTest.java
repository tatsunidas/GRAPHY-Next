/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class VideoRenderServiceTest {

    @TempDir
    Path tmp;

    private VideoRenderService newService(DicomStorageService storage) {
        DicomProperties props = new DicomProperties();
        props.setStorageDir(tmp.resolve("store").toString());
        return new VideoRenderService(storage, props);
    }

    @Test
    void renderedMp4_extractsAndCaches() throws IOException {
        DicomStorageService storage = mock(DicomStorageService.class);
        byte[] payload = "FAKE-MP4-BYTES".getBytes(StandardCharsets.US_ASCII);
        Path dcm = VideoTestDicoms.writeVideoDicom(tmp, UID.MPEG4HP41, 100, 100, 10, 33.3, payload);
        when(storage.resolveInstanceFile("SOP1")).thenReturn(dcm);

        VideoRenderService svc = newService(storage);
        Path mp4 = svc.renderedMp4("SOP1");

        assertNotNull(mp4);
        assertTrue(Files.exists(mp4));
        assertEquals("FAKE-MP4-BYTES", Files.readString(mp4, StandardCharsets.US_ASCII));

        // 2 回目はキャッシュヒットで同一パス。
        Path again = svc.renderedMp4("SOP1");
        assertEquals(mp4, again);
    }

    @Test
    void renderedMp4_notFound_returnsNull() throws IOException {
        DicomStorageService storage = mock(DicomStorageService.class);
        when(storage.resolveInstanceFile("MISSING")).thenReturn(null);
        assertNull(newService(storage).renderedMp4("MISSING"));
    }

    @Test
    void renderedMp4_unsupportedTransferSyntax_throws() throws IOException {
        DicomStorageService storage = mock(DicomStorageService.class);
        Path dcm = VideoTestDicoms.writeVideoDicom(tmp, UID.MPEG2MPML, 100, 100, 10, 33.3,
                "x".getBytes(StandardCharsets.US_ASCII));
        when(storage.resolveInstanceFile("SOP2")).thenReturn(dcm);

        VideoRenderService svc = newService(storage);
        assertThrows(UnsupportedVideoException.class, () -> svc.renderedMp4("SOP2"));
    }

    @Test
    void info_returnsMetadata() throws IOException {
        DicomStorageService storage = mock(DicomStorageService.class);
        Path dcm = VideoTestDicoms.writeVideoDicom(tmp, UID.MPEG4HP41, 200, 300, 15, 40.0,
                "x".getBytes(StandardCharsets.US_ASCII));
        when(storage.resolveInstanceFile("SOP3")).thenReturn(dcm);

        VideoFragmentExtractor.VideoInfo info = newService(storage).info("SOP3");
        assertNotNull(info);
        assertEquals(200, info.rows());
        assertEquals(300, info.columns());
        assertEquals(15, info.numberOfFrames());
        assertEquals(25.0, info.fps(), 0.001);
    }
}
