/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.dose;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.io.DicomInputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 被ばく線量レポート（RDSR）の読み取り API（{@code fw/angio-design.md} §14.2 / A9）。
 *
 * <p>{@code GET /api/studies/{studyUid}/dose} … その検査に含まれる RDSR をすべて解析して返す。
 * RDSR が無ければ {@code reports} が空の JSON（404 にはしない — UI が「線量レポートなし」を
 * 出せるようにするため）。
 *
 * <p>🚨 <b>線量管理システムではない</b>。皮膚線量分布・警告閾値・施設 DRL 比較はやらない。
 */
@RestController
@RequestMapping("/api/studies")
public class DoseController {

    private static final Logger log = LoggerFactory.getLogger(DoseController.class);

    private final DicomStorageService storage;

    public DoseController(DicomStorageService storage) {
        this.storage = storage;
    }

    /** 検査の線量サマリ。 */
    public record StudyDoseDto(
            String studyInstanceUid,
            List<RdsrParser.DoseReport> reports,
            /** 全レポート合算のサマリ（見つからない項目は null）。 */
            Summary summary) {
    }

    /**
     * よく見る積算値のサマリ。<b>CodeMeaning の部分一致</b>で拾うので、
     * 装置が別の言い回しを使っていると null になる（その場合も {@code reports} には全項目が入っている）。
     */
    public record Summary(
            Double doseAreaProductTotal,
            Double doseRpTotal,
            Double fluoroTimeTotal,
            int irradiationEventCount) {
    }

    @GetMapping("/{studyUid}/dose")
    public ResponseEntity<StudyDoseDto> studyDose(@PathVariable String studyUid) {
        List<RdsrParser.DoseReport> reports = new ArrayList<>();
        for (Path path : storage.resolveFiles(studyUid, null)) {
            Attributes ds = readQuietly(path);
            if (ds == null || !RdsrParser.isRdsr(ds)) {
                continue;
            }
            RdsrParser.DoseReport r = RdsrParser.parse(ds);
            if (r != null) {
                reports.add(r);
            }
        }

        List<RdsrParser.DoseItem> allAccumulated = new ArrayList<>();
        int events = 0;
        for (RdsrParser.DoseReport r : reports) {
            allAccumulated.addAll(r.accumulated());
            events += r.events().size();
        }
        Summary summary = new Summary(
                RdsrParser.sumByMeaning(allAccumulated, "dose area product total"),
                RdsrParser.sumByMeaning(allAccumulated, "dose (rp) total"),
                RdsrParser.sumByMeaning(allAccumulated, "fluoro time"),
                events);
        return ResponseEntity.ok(new StudyDoseDto(studyUid, reports, summary));
    }

    private static Attributes readQuietly(Path path) {
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            // SR は PixelData を持たないので、ここで全内容（ContentSequence 含む）が読める。
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            return in.readDatasetUntilPixelData();
        } catch (IOException e) {
            log.warn("dose: SR 読取失敗 {}", path, e);
            return null;
        }
    }
}
