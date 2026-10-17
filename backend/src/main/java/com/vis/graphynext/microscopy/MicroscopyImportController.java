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
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 顕微鏡の画素（Raw）を Confocal Microscopy Image（CFM・32 ビット・規格外）として取り込む（fw/microscopy-cfm.md）。
 * LSM・PIC を読むプラグインが、チャネルごとに画素を Raw に書き出して呼ぶ（host API H68）。ローカル FS のパスなので standalone だけ。
 *
 * <ul>
 *   <li>{@code POST /api/microscopy/import} … 1 チャネル＝1 シリーズとして取り込む</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/microscopy")
@Profile("standalone") // サーバー上のパスを受けるので web では出さない（fw/security.md「サーバー上のパス」）
public class MicroscopyImportController {

    private final DicomStorageService storage;
    private final InstallationIdentity identity;

    public MicroscopyImportController(DicomStorageService storage, InstallationIdentity identity) {
        this.storage = storage;
        this.identity = identity;
    }

    /**
     * @param spec      画素の読み方（phases が時相 T）。画素間隔は {x, y, z} mm
     * @param anatomy   解剖部位のコード（省略で SCT 91723000 "Anatomical Structure"）
     * @param studyInstanceUid 同じ検査にまとめるとき（チャネルを順に取り込むプラグインが 2 本目から渡す）
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

    public record ImportResponse(String studyInstanceUid, String seriesInstanceUid, String frameOfReferenceUid,
                                 String specimenUid, int frames, String error) {
    }

    @PostMapping("/import")
    public ResponseEntity<ImportResponse> importChannel(@RequestBody ImportRequest req) {
        Path file = req == null || req.path() == null || req.path().isBlank() ? null : Path.of(req.path());
        if (file == null || !Files.isRegularFile(file)) {
            return bad("ファイルが見つかりません");
        }
        if (req.spec() == null) {
            return bad("読み方の指定がありません");
        }
        try {
            RawSpec s = req.spec();
            long required = s.requiredBytes();
            long size = Files.size(file);
            if (required > size) {
                return bad("画素がファイルに足りません（必要 " + required + " バイト・ファイル " + size + " バイト）");
            }
            int nz = s.slices();
            int nt = Math.max(1, s.phases());
            int n = s.width() * s.height();
            int frameBytes = n * s.bytesPerVoxel();
            List<float[]> frames = new ArrayList<>(nz * nt);
            try (InputStream in = Files.newInputStream(file)) {
                in.skipNBytes(s.offset());
                for (int i = 0; i < nz * nt; i++) {
                    byte[] raw = in.readNBytes(frameBytes);
                    double[] d = RawPreview.decode(raw, s, n);
                    float[] f = new float[n];
                    for (int k = 0; k < n; k++) {
                        f[k] = (float) d[k];
                    }
                    frames.add(f);
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
            return ResponseEntity.ok(new ImportResponse(study, series, forUid, specimen, frames.size(), null));
        } catch (IllegalArgumentException e) { // RawSpec.InvalidSpec も含む
            return bad(e.getMessage());
        } catch (IOException e) {
            return bad("取り込めません: " + e.getMessage());
        }
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    private static ResponseEntity<ImportResponse> bad(String msg) {
        return ResponseEntity.badRequest().body(new ImportResponse(null, null, null, null, 0, msg));
    }
}
