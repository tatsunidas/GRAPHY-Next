/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * DICOM SRO の保存と読み出し（設計 {@code fw/registration-design.md} R5）。
 *
 * <p><b>なぜ SRO なのか</b>: アプリ内の永続化（{@link RegistrationDocumentService}）は
 * 「開き直せば同じ絵」を成立させるが、GRAPHY のデータ領域を消せば失われ、他システムからは
 * 読めない。SRO は<b>患者記録の一部</b>として検査の中に入り、媒体にも PACS にも載る。
 *
 * <p>向きの規約と既知の限界は {@link SpatialRegistrationCodec} を参照。
 */
@Service
public class SpatialRegistrationService {

    private static final Logger log = LoggerFactory.getLogger(SpatialRegistrationService.class);

    private final DicomStorageService storage;

    public SpatialRegistrationService(DicomStorageService storage) {
        this.storage = storage;
    }

    public record CreateResult(String sopInstanceUid, String seriesInstanceUid, boolean deformable) {
    }

    /**
     * SRO を作って保管庫へ取り込む。
     *
     * @param studyInstanceUid  置き場所（fixed 側の検査）
     * @param fixedSeriesUid    患者・検査属性の引き継ぎ元
     */
    public CreateResult create(String studyInstanceUid, String fixedSeriesUid,
                               SpatialRegistrationCodec.Input inputWithoutTemplate) throws IOException {
        Attributes tmpl = readTemplate(studyInstanceUid, fixedSeriesUid);
        SpatialRegistrationCodec.Input in = new SpatialRegistrationCodec.Input(
                tmpl,
                inputWithoutTemplate.fixedFrameOfReferenceUid(),
                inputWithoutTemplate.movingFrameOfReferenceUid(),
                inputWithoutTemplate.fixedToMoving(),
                inputWithoutTemplate.dvf(),
                inputWithoutTemplate.contentLabel(),
                inputWithoutTemplate.contentDescription());
        validate(in);

        Attributes sro = SpatialRegistrationCodec.build(in);
        ingest(sro);
        boolean deformable = in.dvf() != null;
        log.info("SRO created: {} ({}) study={} fixedFoR={} movingFoR={}",
                sro.getString(Tag.SOPInstanceUID), deformable ? "deformable" : "rigid",
                studyInstanceUid, in.fixedFrameOfReferenceUid(), in.movingFrameOfReferenceUid());
        return new CreateResult(sro.getString(Tag.SOPInstanceUID),
                sro.getString(Tag.SeriesInstanceUID), deformable);
    }

    /** 検査の中の SRO をすべて読む。壊れた 1 件で全部が読めなくならないようにする。 */
    public List<SpatialRegistrationCodec.Parsed> list(String studyInstanceUid) throws IOException {
        List<SpatialRegistrationCodec.Parsed> out = new ArrayList<>();
        // seriesUids に null を渡すとスタディ全体。SRO は独立したシリーズになるので、
        // どのシリーズに入ったかを呼び出し側が知らなくても拾えるようにする。
        for (Path p : storage.resolveFiles(studyInstanceUid, null)) {
            Attributes a;
            try {
                a = readHeader(p);
            } catch (Exception e) {
                continue;
            }
            String sopClass = a.getString(Tag.SOPClassUID, "");
            if (!SpatialRegistrationCodec.RIGID_SOP_CLASS.equals(sopClass)
                    && !SpatialRegistrationCodec.DEFORMABLE_SOP_CLASS.equals(sopClass)) {
                continue;
            }
            try {
                out.add(SpatialRegistrationCodec.parse(a));
            } catch (Exception e) {
                // 1 件が壊れていても残りは返す。読めないことを黙って隠さずログに残す。
                log.warn("SRO を読めませんでした: {} ({})", p, e.getMessage());
            }
        }
        return out;
    }

    private void validate(SpatialRegistrationCodec.Input in) {
        if (in.fixedFrameOfReferenceUid() == null || in.fixedFrameOfReferenceUid().isBlank()
                || in.movingFrameOfReferenceUid() == null || in.movingFrameOfReferenceUid().isBlank()) {
            // FoR が無い＝患者座標系が定義されていない。SRO は FoR どうしの関係なので成立しない。
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "SRO には fixed / moving 双方の FrameOfReferenceUID が必要です"
                    + "（位置情報の無いシリーズは対象にできません）");
        }
        if (in.fixedFrameOfReferenceUid().equals(in.movingFrameOfReferenceUid())) {
            // 同じ FoR を登録しても意味が無く、読み手は moving 側の項目を見分けられない。
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "fixed と moving の FrameOfReferenceUID が同じです。"
                    + "同じ座標系どうしの登録は SRO として表現できません");
        }
        double[] m = in.fixedToMoving();
        if (m == null || m.length != 16) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "変換行列は 16 要素が必要です");
        }
        SpatialRegistrationCodec.Dvf d = in.dvf();
        if (d != null) {
            if (d.dims() == null || d.dims().length != 3
                    || d.originMm() == null || d.originMm().length != 3
                    || d.spacingMm() == null || d.spacingMm().length != 3) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "変位場の格子指定が不正です");
            }
            long expected = (long) d.dims()[0] * d.dims()[1] * d.dims()[2] * 3;
            if (d.displacementsMm() == null || d.displacementsMm().length != expected) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "変位の要素数が格子と一致しません（期待 " + expected + "）");
            }
        }
    }

    private Attributes readTemplate(String studyInstanceUid, String seriesInstanceUid) throws IOException {
        List<Path> files = storage.resolveFiles(studyInstanceUid, List.of(seriesInstanceUid));
        if (files.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "元シリーズが見つかりません (study=" + studyInstanceUid + ", series=" + seriesInstanceUid + ")");
        }
        return readHeader(files.get(0));
    }

    private static Attributes readHeader(Path file) throws IOException {
        try (DicomInputStream dis = new DicomInputStream(file.toFile())) {
            dis.setIncludeBulkData(IncludeBulkData.NO);
            return dis.readDataset();
        }
    }

    private void ingest(Attributes attrs) throws IOException {
        Path tmp = Files.createTempFile("sro-", ".dcm");
        boolean consumed = false;
        try {
            Attributes fmi = attrs.createFileMetaInformation(SpatialRegistrationCodec.transferSyntax());
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(fmi, attrs);
            }
            storage.ingest(tmp);
            consumed = true;
        } finally {
            if (!consumed) {
                Files.deleteIfExists(tmp);
            }
        }
    }
}
