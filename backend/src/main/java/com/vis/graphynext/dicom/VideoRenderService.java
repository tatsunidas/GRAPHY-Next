/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;

/**
 * encapsulated video DICOM を、ブラウザ再生可能な MP4 として供給するためのサービス（standalone）。
 *
 * <p>取込済みの Video Photographic は encapsulated PixelData に H.264 の MP4 を丸ごと持つため、
 * <b>抽出（フラグメント連結）してキャッシュに落とすだけ</b>で {@code video/mp4} 配信できる（再変換不要）。
 * MPEG2 等の非対応転送構文は {@link UnsupportedVideoException}（P4 で ffmpeg 変換予定）。
 *
 * <p>キャッシュは既存作法（`.import` 一時領域と同様に {@code storage-dir} 配下のサブディレクトリ）に倣い、
 * {@code <storageDir>/.video-cache/<sop>.mp4} に置く。
 */
@Service
public class VideoRenderService {

    private static final Logger log = LoggerFactory.getLogger(VideoRenderService.class);

    private final DicomStorageService storage;
    private final Path cacheDir;

    public VideoRenderService(DicomStorageService storage, DicomProperties props) {
        this.storage = storage;
        this.cacheDir = Paths.get(props.getStorageDir()).resolve(".video-cache");
    }

    /** 諸元（rows/cols/frames/fps/転送構文）。索引に無ければ null。 */
    public VideoFragmentExtractor.VideoInfo info(String sopUid) throws IOException {
        Path dcm = storage.resolveInstanceFile(sopUid);
        if (dcm == null) {
            return null;
        }
        return VideoFragmentExtractor.readInfo(dcm);
    }

    /**
     * 再生用 MP4 の実ファイル（キャッシュ）を返す。索引に無ければ null。
     *
     * @throws UnsupportedVideoException 転送構文が無変換再生不可（P4 で ffmpeg 変換予定）
     */
    public Path renderedMp4(String sopUid) throws IOException {
        Path dcm = storage.resolveInstanceFile(sopUid);
        if (dcm == null) {
            return null;
        }
        VideoFragmentExtractor.VideoInfo info = VideoFragmentExtractor.readInfo(dcm);
        if (!info.playable()) {
            throw new UnsupportedVideoException(info.transferSyntaxUid());
        }
        return getOrExtract(sopUid, dcm);
    }

    /** キャッシュがあれば（かつ元 DICOM より新しければ）それを、無ければ抽出して返す。 */
    private synchronized Path getOrExtract(String sopUid, Path dcm) throws IOException {
        Files.createDirectories(cacheDir);
        Path cached = cacheDir.resolve(sanitize(sopUid) + ".mp4");
        if (Files.isRegularFile(cached) && Files.size(cached) > 0
                && Files.getLastModifiedTime(cached).toMillis()
                >= Files.getLastModifiedTime(dcm).toMillis()) {
            return cached;
        }
        Path tmp = Files.createTempFile(cacheDir, "extract-", ".mp4");
        try {
            long n = VideoFragmentExtractor.extractTo(dcm, tmp);
            if (n <= 0) {
                throw new IOException("no video fragments extracted from " + sopUid);
            }
            Files.move(tmp, cached, StandardCopyOption.REPLACE_EXISTING);
            log.debug("video extracted: sop={} bytes={} -> {}", sopUid, n, cached);
            return cached;
        } catch (IOException e) {
            Files.deleteIfExists(tmp);
            throw e;
        }
    }

    /** SOP UID（数字とドットのみのはず）をファイル名として無害化。パストラバーサル防止。 */
    private static String sanitize(String sopUid) {
        String s = sopUid.replaceAll("[^0-9A-Za-z._-]", "_");
        return s.length() <= 128 ? s : s.substring(0, 128);
    }
}
