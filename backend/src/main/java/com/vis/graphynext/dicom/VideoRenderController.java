/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpRange;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * encapsulated video の再生用配信（standalone 2D/独立 VideoViewer 用）。
 *
 * <ul>
 *   <li>{@code GET /api/instances/{sop}/rendered} … encapsulated PixelData から MP4 を抽出し
 *       {@code video/mp4} を <b>HTTP Range(206)</b> 対応で配信（{@code <video>}/VideoViewport のシーク用）。</li>
 *   <li>{@code GET /api/instances/{sop}/video-metadata} … rows/cols/frames/fps/転送構文を JSON で返す。</li>
 * </ul>
 *
 * <p>web モードは索引を持たないため 404（動画は §8 のとおり WADO-RS 経由で後追い）。
 */
@RestController
@RequestMapping("/api/instances")
public class VideoRenderController {

    private static final MediaType VIDEO_MP4 = MediaType.parseMediaType("video/mp4");
    private static final String CACHE_CONTROL = "private, max-age=3600";
    /** 415 時に非対応の転送構文を伝えるヘッダ（フロントは「ffmpeg 変換が必要」の案内に使う）。 */
    private static final String UNSUPPORTED_TS_HEADER = "X-Graphy-Video-Unsupported-Ts";

    private final VideoRenderService service;

    public VideoRenderController(VideoRenderService service) {
        this.service = service;
    }

    @GetMapping("/{sopUid}/rendered")
    public ResponseEntity<?> rendered(@PathVariable String sopUid,
                                      @RequestHeader HttpHeaders headers) throws IOException {
        Path mp4;
        try {
            mp4 = service.renderedMp4(sopUid);
        } catch (UnsupportedVideoException e) {
            return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE)
                    .header(UNSUPPORTED_TS_HEADER, e.getTransferSyntaxUid())
                    .build();
        }
        if (mp4 == null) {
            return ResponseEntity.notFound().build();
        }
        long length = Files.size(mp4);

        List<HttpRange> ranges;
        try {
            ranges = headers.getRange();
        } catch (IllegalArgumentException e) {
            return unsatisfiable(length);
        }

        // Range 無し = 全体を（ストリームで）返す。Accept-Ranges を付けてシーク可能を通知。
        if (ranges.isEmpty()) {
            Resource resource = new FileSystemResource(mp4);
            return ResponseEntity.ok()
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .header(HttpHeaders.CACHE_CONTROL, CACHE_CONTROL)
                    .contentType(VIDEO_MP4)
                    .contentLength(length)
                    .body(resource);
        }

        // 単一 Range（ブラウザの動画シークは単一 Range）を手動で 206 応答。
        HttpRange range = ranges.get(0);
        long start = range.getRangeStart(length);
        long end = range.getRangeEnd(length);
        if (start >= length || start > end) {
            return unsatisfiable(length);
        }
        long count = end - start + 1;
        byte[] slice = readSlice(mp4, start, (int) count);
        return ResponseEntity.status(HttpStatus.PARTIAL_CONTENT)
                .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                .header(HttpHeaders.CACHE_CONTROL, CACHE_CONTROL)
                .header(HttpHeaders.CONTENT_RANGE, "bytes " + start + "-" + end + "/" + length)
                .contentType(VIDEO_MP4)
                .contentLength(count)
                .body(slice);
    }

    /** {@code mp4} の {@code start} から {@code count} バイトを読み出す。 */
    private static byte[] readSlice(Path mp4, long start, int count) throws IOException {
        byte[] buf = new byte[count];
        try (SeekableByteChannel ch = Files.newByteChannel(mp4)) {
            ch.position(start);
            ByteBuffer bb = ByteBuffer.wrap(buf);
            while (bb.hasRemaining() && ch.read(bb) > 0) {
                // 読み切るまで
            }
        }
        return buf;
    }

    @GetMapping("/{sopUid}/video-metadata")
    public ResponseEntity<VideoMetadataDto> metadata(@PathVariable String sopUid) throws IOException {
        VideoFragmentExtractor.VideoInfo info = service.info(sopUid);
        if (info == null) {
            return ResponseEntity.notFound().build();
        }
        double fps = info.fps();
        Double durationSec = (fps > 0 && info.numberOfFrames() > 0)
                ? info.numberOfFrames() / fps : null;
        VideoMetadataDto dto = new VideoMetadataDto(
                info.rows(), info.columns(), info.numberOfFrames(),
                info.frameTimeMs() > 0 ? info.frameTimeMs() : null,
                fps > 0 ? fps : null,
                info.cineRate() > 0 ? info.cineRate() : null,
                info.transferSyntaxUid(), info.playable(), durationSec);
        return ResponseEntity.ok(dto);
    }

    private static ResponseEntity<Object> unsatisfiable(long length) {
        return ResponseEntity.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                .header(HttpHeaders.CONTENT_RANGE, "bytes */" + length)
                .build();
    }

    /** 再生 UI とフレーム換算に必要な諸元。 */
    public record VideoMetadataDto(int rows, int columns, int numberOfFrames,
                                   Double frameTimeMs, Double fps, Double cineRate,
                                   String transferSyntaxUid, boolean playable, Double durationSec) {
    }
}
