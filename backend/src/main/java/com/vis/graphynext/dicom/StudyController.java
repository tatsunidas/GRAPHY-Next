/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * スタディ/シリーズ/インスタンスのナビゲーション REST。モードに依らずフロントは同じ URL を叩く。
 * <ul>
 *   <li>web: {@link WebDicomDataService}（QIDO-RS）。</li>
 *   <li>standalone: {@link DicomStorageService} のローカル索引（H2）。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api")
public class StudyController {

    private final DicomStorageService storage;
    private final ObjectProvider<WebDicomDataService> webProvider;

    public StudyController(DicomStorageService storage, ObjectProvider<WebDicomDataService> webProvider) {
        this.storage = storage;
        this.webProvider = webProvider;
    }

    @GetMapping("/studies")
    public List<StudyDto> studies(
            @RequestParam(required = false) String patientId,
            @RequestParam(required = false) String patientName,
            @RequestParam(required = false) String studyDateFrom,
            @RequestParam(required = false) String studyDateTo,
            @RequestParam(required = false) String modality,
            @RequestParam(required = false) String accessionNumber) {
        StudySearch search = new StudySearch(patientId, patientName, studyDateFrom, studyDateTo, modality,
                accessionNumber).normalized();
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            return web.searchStudies(toQido(search)).stream().map(StudyController::studyOf).toList();
        }
        return storage.listStudies(search);
    }

    /** 検索条件を QIDO-RS のクエリキーへ。 */
    private static Map<String, String> toQido(StudySearch s) {
        Map<String, String> q = new LinkedHashMap<>();
        if (s.patientId() != null) {
            q.put("PatientID", s.patientId());
        }
        if (s.patientName() != null) {
            q.put("PatientName", s.patientName());
        }
        // QIDO StudyDate の範囲指定: "from-to" / "from-" / "-to" / 単一日 "yyyymmdd"。
        String dateQuery = toQidoDateRange(s.studyDateFrom(), s.studyDateTo());
        if (dateQuery != null) {
            q.put("StudyDate", dateQuery);
        }
        if (s.modality() != null) {
            q.put("ModalitiesInStudy", s.modality());
        }
        if (s.accessionNumber() != null) {
            q.put("AccessionNumber", s.accessionNumber());
        }
        return q;
    }

    /** DICOM の日付レンジ書式へ。両端 null なら null。 */
    private static String toQidoDateRange(String from, String to) {
        if (from == null && to == null) {
            return null;
        }
        if (from != null && from.equals(to)) {
            return from;
        }
        return (from == null ? "" : from) + "-" + (to == null ? "" : to);
    }

    @GetMapping("/studies/{studyUid}/series")
    public List<SeriesDto> series(@PathVariable String studyUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            return web.searchSeries(studyUid, Map.of()).stream().map(StudyController::seriesOf).toList();
        }
        return storage.listSeries(studyUid);
    }

    /**
     * シリーズの 5D(ZCT) レイアウト。standalone はローカルヘッダから導出。
     * web は次段（QIDO メタからの導出）未対応のため空を返し、フロントは単一次元にフォールバックする。
     */
    @GetMapping("/studies/{studyUid}/series/{seriesUid}/layout")
    public SeriesLayout layout(@PathVariable String studyUid, @PathVariable String seriesUid) {
        if (webProvider.getIfAvailable() != null) {
            return SeriesLayout.noSpatial(0, 0, 0, null, null, List.of());
        }
        return storage.seriesLayout(studyUid, seriesUid);
    }

    /**
     * 範囲外パディング用ブランク DICOM を生成して返す。複数スキャン混在シリーズで、ある C/T が覆わない
     * Z 位置を物理座標に揃えて埋めるために frontend が wadouri で読む。
     * {@code ipp}（"x,y,z"）でブランクの ImagePositionPatient を指定（穴の物理位置）。
     */
    @GetMapping("/studies/{studyUid}/series/{seriesUid}/blank/file")
    public org.springframework.http.ResponseEntity<byte[]> blank(
            @PathVariable String studyUid, @PathVariable String seriesUid,
            @RequestParam(required = false) String ipp) {
        double[] pos = null;
        if (ipp != null && !ipp.isBlank()) {
            String[] p = ipp.split("[,\\\\]");
            if (p.length >= 3) {
                try {
                    pos = new double[] { Double.parseDouble(p[0].trim()), Double.parseDouble(p[1].trim()),
                            Double.parseDouble(p[2].trim()) };
                } catch (NumberFormatException ignore) {
                    pos = null;
                }
            }
        }
        byte[] dicom = storage.blankDicom(studyUid, seriesUid, pos);
        if (dicom == null) {
            return org.springframework.http.ResponseEntity.notFound().build();
        }
        return org.springframework.http.ResponseEntity.ok()
                .contentType(org.springframework.http.MediaType.parseMediaType("application/dicom"))
                .header(org.springframework.http.HttpHeaders.CACHE_CONTROL, "private, max-age=3600")
                .body(dicom);
    }

    @GetMapping("/studies/{studyUid}/series/{seriesUid}/instances")
    public List<InstanceDto> instances(@PathVariable String studyUid, @PathVariable String seriesUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            return web.searchInstances(studyUid, seriesUid, Map.of()).stream()
                    .map(StudyController::instanceOf).toList();
        }
        return storage.listInstances(studyUid, seriesUid);
    }

    // --- QIDO Attributes -> DTO ---

    private static StudyDto studyOf(Attributes a) {
        return new StudyDto(
                a.getString(Tag.StudyInstanceUID),
                a.getString(Tag.PatientID),
                a.getString(Tag.PatientName),
                a.getString(Tag.StudyDate),
                a.getString(Tag.StudyDescription),
                a.getString(Tag.ModalitiesInStudy),
                a.getInt(Tag.NumberOfStudyRelatedInstances, 0));
    }

    private static SeriesDto seriesOf(Attributes a) {
        return new SeriesDto(
                a.getString(Tag.SeriesInstanceUID),
                a.getString(Tag.Modality),
                a.getInt(Tag.SeriesNumber, 0),
                a.getString(Tag.SeriesDescription),
                a.getInt(Tag.NumberOfSeriesRelatedInstances, 0));
    }

    private static InstanceDto instanceOf(Attributes a) {
        return new InstanceDto(
                a.getString(Tag.SOPInstanceUID),
                a.getInt(Tag.InstanceNumber, 0),
                a.getString(Tag.SOPClassUID));
    }
}
