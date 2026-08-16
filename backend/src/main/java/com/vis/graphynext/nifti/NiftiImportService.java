/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.io.DicomOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.vis.graphynext.dicom.store.DicomStorageService;

/**
 * NIfTI を DICOM へ変換して保管庫へ取り込む（standalone のローカル保管庫）。
 *
 * <p>変換そのものは {@link NiftiToDicom}。ここは<b>1 フレームずつ書いては取り込み、
 * 一時ファイルを残さない</b>ことに責任を持つ（4D は数百インスタンスになるため、
 * 全部を一時領域に置いてから取り込むとディスクを二重に使う）。
 */
@Service
public class NiftiImportService {

    private static final Logger log = LoggerFactory.getLogger(NiftiImportService.class);

    private final DicomStorageService storage;

    public NiftiImportService(DicomStorageService storage) {
        this.storage = storage;
    }

    /** 取り込み結果（UI にそのまま出す）。 */
    public record Result(
            int imported, int failed,
            int slices, int phases, int channels, int rows, int columns,
            String geometrySource, boolean geometrySynthesized,
            String studyInstanceUid, String seriesInstanceUid,
            int metadataApplied, String pixelConversion,
            /** スライス間隔などを pixdim から採り直したときの説明（無ければ null）。 */
            String spacingNote,
            String error) {
    }

    /**
     * 変換して取り込む。
     *
     * @param nifti    .nii / .nii.gz の一時ファイル
     * @param metadata サイドカー JSON の内容（無ければ null）
     */
    public Result importFile(Path nifti, Map<String, Object> metadata, NiftiToDicom.Options opts) {
        Path tmpDir;
        try {
            tmpDir = Files.createTempDirectory("graphy-nifti-");
        } catch (IOException e) {
            return failure("一時領域を作れません: " + e.getMessage());
        }
        int[] counts = { 0, 0 }; // imported, failed
        try {
            NiftiToDicom.Options full = new NiftiToDicom.Options(
                    opts.modality(), opts.patientId(), opts.patientName(), opts.patientBirthDate(),
                    opts.patientSex(), opts.studyDate(), opts.studyDescription(), opts.seriesDescription(),
                    opts.seriesNumber(), opts.studyInstanceUid(), opts.seriesInstanceUid(), metadata);

            NiftiToDicom.Summary summary = NiftiToDicom.convert(nifti, full, (ds, tsuid) -> {
                Path tmp = Files.createTempFile(tmpDir, "frame-", ".dcm");
                Attributes fmi = ds.createFileMetaInformation(tsuid);
                try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                    dos.writeDataset(fmi, ds);
                }
                try {
                    storage.importFromFile(tmp);
                    counts[0]++;
                } catch (Exception e) {
                    counts[1]++;
                    log.warn("[nifti] フレームの取り込みに失敗: {}", e.getMessage());
                } finally {
                    Files.deleteIfExists(tmp);
                }
            });

            log.info("[nifti] 取り込み完了: {} 枚（{}×{}×{} slices × {} phases, geometry={}{}{}）",
                    counts[0], summary.columns(), summary.rows(), summary.slices(), summary.phases(),
                    summary.geometrySource(), summary.geometrySynthesized() ? " SYNTHESIZED" : "",
                    summary.spacingNote() == null ? "" : " spacing←pixdim: " + summary.spacingNote());

            return new Result(counts[0], counts[1], summary.slices(), summary.phases(), summary.channels(),
                    summary.rows(), summary.columns(), summary.geometrySource(), summary.geometrySynthesized(),
                    summary.studyInstanceUid(), summary.seriesInstanceUid(), summary.metadataApplied(),
                    summary.pixelConversion(), summary.spacingNote(), null);
        } catch (IOException | RuntimeException e) {
            log.warn("[nifti] 変換に失敗: {}", e.toString());
            return failure(e.getMessage() == null ? e.toString() : e.getMessage());
        } finally {
            deleteQuietly(tmpDir);
        }
    }

    private static Result failure(String message) {
        return new Result(0, 0, 0, 0, 0, 0, 0, null, false, null, null, 0, null, null, message);
    }

    private static void deleteQuietly(Path dir) {
        try (var walk = Files.walk(dir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignore) {
                    // ベストエフォート
                }
            });
        } catch (IOException ignore) {
            // ベストエフォート
        }
    }
}
