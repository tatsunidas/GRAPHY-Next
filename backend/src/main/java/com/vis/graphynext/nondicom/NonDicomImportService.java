/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nondicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 非 DICOM ファイル（PDF / 一般画像 / 動画）を DICOM 化して保管庫へ取り込む。
 *
 * <p>PDF=Encapsulated PDF、画像=Secondary Capture。1 回の取込はモダリティ単位でシリーズを分け
 * （DOC/OT が混在しないように）、同一スタディにまとめる。動画は現状未対応（将来 ffmpeg で対応, fw 参照）。
 */
@Service
public class NonDicomImportService {

    private static final Logger log = LoggerFactory.getLogger(NonDicomImportService.class);

    private static final Set<String> IMAGE_EXT = Set.of("png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff");
    private static final Set<String> VIDEO_EXT = Set.of("mp4", "m4v", "mov", "avi", "mpg", "mpeg", "mkv", "webm", "wmv");

    private final DicomStorageService storage;
    /** 同梱 ffmpeg の解決（AVI / 非 H.264 MP4 のトランスコード用）。 */
    private final FfmpegLocator ffmpegLocator;

    public NonDicomImportService(DicomStorageService storage, FfmpegLocator ffmpegLocator) {
        this.storage = storage;
        this.ffmpegLocator = ffmpegLocator;
    }

    /** 取込リクエスト（紐付け情報＋ファイルパス）。 */
    public record Request(
            List<String> paths,
            String patientId, String patientName, String patientBirthDate, String patientSex,
            String studyInstanceUid, String studyDescription, String accessionNumber,
            String seriesDescription) {}

    /** ファイル 1 件の結果。 */
    public record FileOutcome(String filename, String status, String sopClass, String message) {}

    /** 取込結果。 */
    public record Result(int imported, int skipped, int failed, String studyInstanceUid, List<FileOutcome> files) {}

    public Result importFiles(Request req) {
        if (req == null) {
            return new Result(0, 0, 0, "", List.of());
        }
        String studyUid = isBlank(req.studyInstanceUid()) ? UIDUtils.createUID() : req.studyInstanceUid().trim();
        String studyDate = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
        String studyTime = LocalTime.now().format(DateTimeFormatter.ofPattern("HHmmss"));

        // モダリティ単位のシリーズ（DOC=PDF, OT=画像）。
        Map<String, int[]> instNoByModality = new LinkedHashMap<>(); // modality -> [seriesNumber, nextInstanceNo]
        Map<String, String> seriesUidByModality = new LinkedHashMap<>();

        int imported = 0;
        int skipped = 0;
        int failed = 0;
        List<FileOutcome> outcomes = new ArrayList<>();

        for (String p : req.paths() == null ? List.<String>of() : req.paths()) {
            Path path;
            String filename;
            try {
                path = Path.of(p);
                filename = path.getFileName().toString();
            } catch (RuntimeException e) {
                failed++;
                outcomes.add(new FileOutcome(String.valueOf(p), "failed", "", "invalid path"));
                continue;
            }
            if (!Files.isRegularFile(path)) {
                skipped++;
                outcomes.add(new FileOutcome(filename, "skipped", "", "not a file"));
                continue;
            }
            String ext = ext(filename);
            String modality = modalityFor(ext);
            if (modality == null) {
                skipped++;
                outcomes.add(new FileOutcome(filename, "skipped", "", "unsupported type"));
                continue;
            }

            // モダリティのシリーズ確保
            String seriesUid = seriesUidByModality.computeIfAbsent(modality, k -> UIDUtils.createUID());
            int[] meta = instNoByModality.computeIfAbsent(modality,
                    k -> new int[] {instNoByModality.size() + 1, 0});
            int instanceNo = ++meta[1];

            NonDicomConverter.Ctx ctx = new NonDicomConverter.Ctx(
                    req.patientId(), req.patientName(), req.patientBirthDate(), req.patientSex(),
                    studyUid, studyDate, studyTime, req.studyDescription(), req.accessionNumber(),
                    seriesUid, meta[0], req.seriesDescription(), modality, instanceNo);

            try {
                String sopClass;
                if (VIDEO_EXT.contains(ext)) {
                    // 動画は encapsulated（MP4 全体を 1 フラグメント）で書き出す専用経路。
                    Path part10 = Files.createTempFile("nondicom-video-", ".dcm");
                    try {
                        VideoConverter.writeVideoDicom(ctx, path, part10, ffmpegLocator.resolve());
                        storage.importFromFile(part10);
                    } finally {
                        Files.deleteIfExists(part10);
                    }
                    sopClass = UID.VideoPhotographicImageStorage;
                } else {
                    Attributes attrs = convert(ctx, ext, path, filename);
                    ingest(attrs);
                    sopClass = attrs.getString(Tag.SOPClassUID);
                }
                imported++;
                outcomes.add(new FileOutcome(filename, "imported", sopClass, ""));
            } catch (UnsupportedOperationException e) {
                meta[1]--; // 採番を戻す
                skipped++;
                outcomes.add(new FileOutcome(filename, "skipped", "", msgOf(e)));
            } catch (Exception e) {
                meta[1]--;
                failed++;
                log.warn("nondicom: 変換/取込失敗 {}", filename, e);
                outcomes.add(new FileOutcome(filename, "failed", "", msgOf(e)));
            }
        }
        return new Result(imported, skipped, failed, studyUid, outcomes);
    }

    private Attributes convert(NonDicomConverter.Ctx ctx, String ext, Path path, String filename) throws IOException {
        if ("pdf".equals(ext)) {
            byte[] pdf = Files.readAllBytes(path);
            return NonDicomConverter.encapsulatedPdf(ctx, stripExt(filename), pdf);
        }
        if (IMAGE_EXT.contains(ext)) {
            BufferedImage img = ImageIO.read(path.toFile());
            if (img == null) {
                throw new UnsupportedOperationException("decode failed (unsupported image)");
            }
            return NonDicomConverter.secondaryCapture(ctx, img);
        }
        throw new UnsupportedOperationException("unsupported type");
    }

    /** Part-10 の一時ファイルに書き出してから保管庫へ取り込む（取込後に一時ファイルを削除）。 */
    private void ingest(Attributes attrs) throws IOException {
        Path tmp = Files.createTempFile("nondicom-", ".dcm");
        try {
            Attributes fmi = attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(fmi, attrs);
            }
            storage.importFromFile(tmp);
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    private static String modalityFor(String ext) {
        if ("pdf".equals(ext)) {
            return "DOC";
        }
        if (IMAGE_EXT.contains(ext)) {
            return "OT";
        }
        if (VIDEO_EXT.contains(ext)) {
            return "XC"; // Video Photographic Image（External-camera Photography）
        }
        return null; // unknown
    }

    private static String ext(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot < 0 ? "" : filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static String stripExt(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot < 0 ? filename : filename.substring(0, dot);
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    /** 例外メッセージを非 null 化（null の場合はクラス名）。 */
    private static String msgOf(Exception e) {
        String m = e.getMessage();
        return m != null ? m : e.getClass().getSimpleName();
    }
}
