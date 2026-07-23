/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.UID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(VideoRenderController.class)
@ActiveProfiles("standalone")
class VideoRenderControllerTest {

    @Autowired
    MockMvc mockMvc;

    @MockBean
    VideoRenderService service;

    @TempDir
    Path tmp;

    private Path mp4; // 16 bytes of known content

    @BeforeEach
    void setUp() throws IOException {
        mp4 = Files.createTempFile(tmp, "vid-", ".mp4");
        Files.write(mp4, "0123456789ABCDEF".getBytes(StandardCharsets.US_ASCII)); // length 16
    }

    @Test
    void rendered_full_servesVideoMp4WithAcceptRanges() throws Exception {
        when(service.renderedMp4("SOP")).thenReturn(mp4);
        mockMvc.perform(get("/api/instances/SOP/rendered"))
                .andExpect(status().isOk())
                .andExpect(header().string("Accept-Ranges", "bytes"))
                .andExpect(header().string("Content-Type", "video/mp4"))
                .andExpect(header().longValue("Content-Length", 16));
    }

    @Test
    void rendered_range_returns206WithContentRange() throws Exception {
        when(service.renderedMp4("SOP")).thenReturn(mp4);
        mockMvc.perform(get("/api/instances/SOP/rendered").header("Range", "bytes=0-3"))
                .andExpect(status().isPartialContent())
                .andExpect(header().string("Accept-Ranges", "bytes"))
                .andExpect(header().string("Content-Range", "bytes 0-3/16"));
    }

    @Test
    void rendered_notFound_returns404() throws Exception {
        when(service.renderedMp4("NOPE")).thenReturn(null);
        mockMvc.perform(get("/api/instances/NOPE/rendered"))
                .andExpect(status().isNotFound());
    }

    @Test
    void rendered_unsupportedCodec_returns415() throws Exception {
        when(service.renderedMp4("M2")).thenThrow(new UnsupportedVideoException(UID.MPEG2MPML));
        mockMvc.perform(get("/api/instances/M2/rendered"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(header().string("X-Graphy-Video-Unsupported-Ts", UID.MPEG2MPML));
    }

    @Test
    void metadata_returnsJson() throws Exception {
        when(service.info("SOP")).thenReturn(
                new VideoFragmentExtractor.VideoInfo(480, 640, 30, 40.0, 0, UID.MPEG4HP41));
        mockMvc.perform(get("/api/instances/SOP/video-metadata"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.rows").value(480))
                .andExpect(jsonPath("$.columns").value(640))
                .andExpect(jsonPath("$.numberOfFrames").value(30))
                .andExpect(jsonPath("$.fps").value(25.0))
                .andExpect(jsonPath("$.playable").value(true))
                .andExpect(jsonPath("$.transferSyntaxUid").value(UID.MPEG4HP41));
    }

    @Test
    void metadata_notFound_returns404() throws Exception {
        when(service.info("NOPE")).thenReturn(null);
        mockMvc.perform(get("/api/instances/NOPE/video-metadata"))
                .andExpect(status().isNotFound());
    }
}
