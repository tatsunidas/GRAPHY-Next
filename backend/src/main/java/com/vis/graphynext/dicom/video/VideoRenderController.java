/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.video;

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
import java.nio.file.Path;

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
 * <p>P4 でブラウザ非対応の中身（MPEG2 等）も配信できるようになった。実際の変換判断は
 * {@link VideoRenderService} が<b>ペイロードの中身</b>で行う（MP4 はそのまま／H.264・HEVC の基本ストリームは
 * remux／MPEG2 等は再エンコード）。ffmpeg が無くて変換できない時だけ {@code 415 Unsupported Media Type} を
 * 返し、UI が案内を出す。web モードでは索引が無いため 404（動画は WADO-RS 経由取得＝後追い）。
 */
@RestController
@RequestMapping("/api/instances")
public class VideoRenderController {

    private static final Logger log = LoggerFactory.getLogger(VideoRenderController.class);

    private static final MediaType VIDEO_MP4 = MediaType.parseMediaType("video/mp4");

    private final DicomStorageService storage;
    /** 抽出/変換とキャッシュ（{@code <storageDir>/.cache/video/{sop}.mp4}）を担う。 */
    private final VideoRenderService renderService;

    public VideoRenderController(DicomStorageService storage, VideoRenderService renderService) {
        this.storage = storage;
        this.renderService = renderService;
    }

    @GetMapping("/{sopUid}/video-metadata")
    public ResponseEntity<VideoMetadataDto> videoMetadata(@PathVariable String sopUid) {
        Path path = storage.resolveInstanceFile(sopUid);
        if (path == null) {
            return ResponseEntity.notFound().build();
        }
        try {
            VideoMeta m = VideoFragmentExtractor.readMeta(path);
            // transcodeRequired は転送構文から見た「サーバ側変換が要るか」のヒント。
            // transcodeAvailable が真なら /rendered が変換して配信できるので、UI は再生を試みてよい。
            return ResponseEntity.ok(new VideoMetadataDto(
                    m.rows(), m.columns(), m.numberOfFrames(), m.fps(),
                    m.frameTimeMs(), m.cineRate(), m.durationSec(),
                    m.transferSyntaxUid(), m.transcodeRequired(),
                    renderService.transcodeAvailable()));
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
        Path mp4;
        try {
            mp4 = renderService.ensureRendered(path, sopUid);
        } catch (VideoRenderService.TranscodeUnavailableException e) {
            // ffmpeg が無いので変換できない（＝この環境では再生できない）。UI が案内を出す。
            log.info("rendered: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).build();
        } catch (IOException e) {
            log.warn("rendered: MP4 の用意に失敗 {}", sopUid, e);
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

    /** {@code /video-metadata} のレスポンス。 */
    public record VideoMetadataDto(
            int rows, int columns, int numberOfFrames, double fps,
            Double frameTimeMs, Double cineRate, Double durationSec,
            String transferSyntaxUid, boolean transcodeRequired, boolean transcodeAvailable) {}
}
