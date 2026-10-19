/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.microscopy;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.nifti.RawPreview;
import com.vis.graphynext.nifti.RawSpec;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BiConsumer;

/**
 * 顕微鏡の画素（Raw）の 1 チャネルを CFM（32 ビット・規格外）として取り込む（fw/microscopy-cfm.md）。
 * 手元の取り込み（{@code /api/microscopy/import}）とプラグイン（H68、{@code /api/plugins/{id}/microscopy/import}）の両方から使う。
 */
@Service
@Profile("standalone")
public class MicroscopyImportService {

    private final DicomStorageService storage;
    private final InstallationIdentity identity;

    public MicroscopyImportService(DicomStorageService storage, InstallationIdentity identity) {
        this.storage = storage;
        this.identity = identity;
    }

    /**
     * @param spec      画素の読み方（phases が時相 T）。画素間隔は {x, y, z} mm
     * @param anatomy   解剖部位のコード（省略で SCT 91723000 "Anatomical Structure"）
     * @param studyInstanceUid 同じ検査にまとめるとき（チャネルを順に取り込むときに 2 本目から渡す）
     * @param frameOfReferenceUid チャネル間で共有する（同じく 2 本目から渡す）
     * @param specimenUid チャネル間で共有する
     */
    public record ImportRequest(String path, RawSpec spec, String channelName, Double wavelengthNm,
                                String confocalMode, String sourceFormat, String sourceName,
                                ConfocalMicroscopyWriter.Code anatomy,
                                String patientId, String patientName, String patientBirthDate, String patientSex,
                                String studyInstanceUid, String studyDescription, String seriesDescription,
                                Integer seriesNumber, String frameOfReferenceUid, String specimenUid) {
    }

    public record ImportResult(String studyInstanceUid, String seriesInstanceUid, String frameOfReferenceUid,
                               String specimenUid, int frames) {
    }

    /**
     * 取り込む。読み方の誤り・画素の不足は {@link IllegalArgumentException}（理由を利用者に見せてよい）。
     *
     * @param progress 進み具合（0〜1 と短い説明。null 可）
     */
    public ImportResult importChannel(ImportRequest req, BiConsumer<Double, String> progress) throws IOException {
        Path file = req == null || req.path() == null || req.path().isBlank() ? null : Path.of(req.path());
        if (file == null || !Files.isRegularFile(file)) {
            throw new IllegalArgumentException("ファイルが見つかりません");
        }
        if (req.spec() == null) {
            throw new IllegalArgumentException("読み方の指定がありません");
        }
        RawSpec s = req.spec();
        long required = s.requiredBytes();
        long size = Files.size(file);
        if (required > size) {
            throw new IllegalArgumentException("画素がファイルに足りません（必要 " + required + " バイト・ファイル " + size + " バイト）");
        }
        int nz = s.slices();
        int nt = Math.max(1, s.phases());
        int n = s.width() * s.height();
        int frameBytes = n * s.bytesPerVoxel();
        int total = nz * nt;
        List<float[]> frames = new ArrayList<>(total);
        try (InputStream in = Files.newInputStream(file)) {
            in.skipNBytes(s.offset());
            for (int i = 0; i < total; i++) {
                byte[] raw = in.readNBytes(frameBytes);
                double[] d = RawPreview.decode(raw, s, n);
                float[] f = new float[n];
                for (int k = 0; k < n; k++) {
                    f[k] = (float) d[k];
                }
                frames.add(f);
                if (progress != null) {
                    progress.accept(0.8 * (i + 1) / total, "読み込み " + (i + 1) + "/" + total);
                }
            }
        }
        String study = blank(req.studyInstanceUid()) ? UIDUtils.createUID() : req.studyInstanceUid();
        String series = UIDUtils.createUID();
        String forUid = blank(req.frameOfReferenceUid()) ? UIDUtils.createUID() : req.frameOfReferenceUid();
        String specimen = blank(req.specimenUid()) ? UIDUtils.createUID() : req.specimenUid();
        Attributes ds = ConfocalMicroscopyWriter.write(new ConfocalMicroscopyWriter.Request(
                s.width(), s.height(), nz, nt, frames, s.spacing(), req.channelName(), req.wavelengthNm(),
                req.confocalMode(), req.sourceFormat(), req.sourceName(), req.anatomy(), identity.equipment(),
                req.patientId(), req.patientName(), req.patientBirthDate(), req.patientSex(),
                study, req.studyDescription(), series, req.seriesDescription(),
                req.seriesNumber() == null ? 1 : req.seriesNumber(), forUid, specimen));
        Path tmp = Files.createTempFile("cfm-", ".dcm");
        try {
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
            }
            storage.importFromFile(tmp);
        } finally {
            Files.deleteIfExists(tmp);
        }
        if (progress != null) {
            progress.accept(1.0, "取り込み済み");
        }
        return new ImportResult(study, series, forUid, specimen, frames.size());
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
