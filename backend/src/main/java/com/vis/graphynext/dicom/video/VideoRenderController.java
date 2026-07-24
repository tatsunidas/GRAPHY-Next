/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.video;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.video.VideoFragmentExtractor.VideoMeta;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * encapsulated video（PixelData=MP4）を <b>ブラウザ再生可能な {@code video/mp4}</b> として供給する
 * standalone 用エンドポイント。2D ビューア内の動画再生（{@code VideoViewer.tsx}）が読む。
 *
 * <ul>
 *   <li>{@code GET /api/instances/{sop}/rendered} … PixelData から MP4 を抽出しキャッシュ、
 *       {@link FileSystemResource} で返す。{@code Range:} は Spring が {@code 206 Partial Content} で自動処理し、
 *       {@code <video>}/VideoViewport のシークに応じる。</li>
 *   <li>{@code GET /api/instances/{sop}/video-metadata} … Rows/Columns/NumberOfFrames/fps 等を JSON で返す。</li>
 * </ul>
 *
 * <p>P1 スコープでは無変換で配信できる転送構文（H.264/HEVC 系）のみ対応。MPEG2 等ブラウザ非対応の
 * 転送構文は {@code 415 Unsupported Media Type} を返す（ffmpeg トランスコードは P4）。web モードでは
 * 索引が無いため 404（動画は WADO-RS 経由取得＝後追い）。
 */
@RestController
@RequestMapping("/api/instances")
public class VideoRenderController {

    private static final Logger log = LoggerFactory.getLogger(VideoRenderController.class);

    private static final MediaType VIDEO_MP4 = MediaType.parseMediaType("video/mp4");

    private final DicomStorageService storage;
    /** 抽出/変換済み MP4 のキャッシュ（{@code <storageDir>/.cache/video/{sop}.mp4}）。 */
    private final Path cacheDir;

    public VideoRenderController(DicomStorageService storage, DicomProperties props) {
        this.storage = storage;
        this.cacheDir = Paths.get(props.getStorageDir(), ".cache", "video");
    }

    @GetMapping("/{sopUid}/video-metadata")
    public ResponseEntity<VideoMetadataDto> videoMetadata(@PathVariable String sopUid) {
        Path path = storage.resolveInstanceFile(sopUid);
        if (path == null) {
            return ResponseEntity.notFound().build();
        }
        try {
            VideoMeta m = VideoFragmentExtractor.readMeta(path);
            return ResponseEntity.ok(new VideoMetadataDto(
                    m.rows(), m.columns(), m.numberOfFrames(), m.fps(),
                    m.frameTimeMs(), m.cineRate(), m.durationSec(),
                    m.transferSyntaxUid(), m.transcodeRequired()));
        } catch (IOException e) {
            log.warn("video-metadata: 読取失敗 {}", sopUid, e);
            return ResponseEntity.notFound().build();
        }
    }

    @GetMapping("/{sopUid}/rendered")
    public ResponseEntity<Resource> rendered(@PathVariable String sopUid) {
        Path path = storage.resolveInstanceFile(sopUid);
        if (path == null) {
            return ResponseEntity.notFound().build();
        }
        VideoMeta meta;
        try {
            meta = VideoFragmentExtractor.readMeta(path);
        } catch (IOException e) {
            log.warn("rendered: メタ読取失敗 {}", sopUid, e);
            return ResponseEntity.notFound().build();
        }
        if (meta.transcodeRequired()) {
            // P4: MPEG2 等は ffmpeg で H.264 MP4 にトランスコードして配信。現状は非対応を明示。
            log.info("rendered: 無変換配信できない転送構文 {} (sop={})", meta.transferSyntaxUid(), sopUid);
            return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).build();
        }
        Path mp4 = cacheDir.resolve(sanitize(sopUid) + ".mp4");
        try {
            if (!Files.exists(mp4) || Files.size(mp4) == 0) {
                VideoFragmentExtractor.extractTo(path, mp4);
            }
        } catch (IOException e) {
            log.warn("rendered: MP4 抽出失敗 {}", sopUid, e);
            return ResponseEntity.internalServerError().build();
        }
        Resource body = new FileSystemResource(mp4);
        return ResponseEntity.ok()
                .contentType(VIDEO_MP4)
                // Range 対応（206）で <video>/VideoViewport のシークに応じる。Spring が Resource の
                // Range 要求を ResourceRegion で自動処理する。
                .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                .header(HttpHeaders.CACHE_CONTROL, "private, max-age=3600")
                .header(HttpHeaders.CONTENT_DISPOSITION, "inline")
                .body(body);
    }

    /** SOPInstanceUID をファイル名に使うためのサニタイズ（英数字とドットのみ許可、パストラバーサル防止）。 */
    private static String sanitize(String sopUid) {
        String s = sopUid.replaceAll("[^0-9A-Za-z.]", "_");
        return s.length() <= 128 ? s : s.substring(0, 128);
    }

    /** {@code /video-metadata} のレスポンス。 */
    public record VideoMetadataDto(
            int rows, int columns, int numberOfFrames, double fps,
            Double frameTimeMs, Double cineRate, Double durationSec,
            String transferSyntaxUid, boolean transcodeRequired) {}
}
