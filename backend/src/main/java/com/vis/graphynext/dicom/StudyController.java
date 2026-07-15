/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import com.vis.graphynext.tagview.TagDumpService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
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
    private final TagDumpService tagDump;

    public StudyController(DicomStorageService storage, ObjectProvider<WebDicomDataService> webProvider,
            TagDumpService tagDump) {
        this.storage = storage;
        this.webProvider = webProvider;
        this.tagDump = tagDump;
    }

    @GetMapping("/studies")
    public List<StudyDto> studies(
            @RequestParam(required = false) String patientId,
            @RequestParam(required = false) String patientName,
            @RequestParam(required = false) String studyDateFrom,
            @RequestParam(required = false) String studyDateTo,
            @RequestParam(required = false) String modality,
            @RequestParam(required = false) String accessionNumber,
            @RequestParam(required = false) String studyInstanceUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        // IHE IID 起動: StudyInstanceUID 直接指定（検索条件は無視して当該 study を返す）。
        if (studyInstanceUid != null && !studyInstanceUid.isBlank()) {
            if (web != null) {
                return web.searchStudies(Map.of("StudyInstanceUID", studyInstanceUid)).stream()
                        .map(StudyController::studyOf).toList();
            }
            return storage.listStudies(new StudySearch(null, null, null, null, null, null).normalized()).stream()
                    .filter(s -> studyInstanceUid.equals(s.studyInstanceUid())).toList();
        }
        StudySearch search = new StudySearch(patientId, patientName, studyDateFrom, studyDateTo, modality,
                accessionNumber).normalized();
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
     * シリーズの 5D(ZCT) レイアウト。standalone はローカルヘッダから、web は WADO-RS {@code /metadata}
     * の全属性から {@link SeriesLayoutAssembler} で導出する（standalone と同一の Z 投影・C/T 判定）。
     * web でメタ取得に失敗したら空を返し、フロントは単一次元 Z にフォールバックする。
     */
    @GetMapping("/studies/{studyUid}/series/{seriesUid}/layout")
    public SeriesLayout layout(@PathVariable String studyUid, @PathVariable String seriesUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            try {
                return SeriesLayoutAssembler.fromAttributes(web.seriesMetadata(studyUid, seriesUid));
            } catch (Exception e) {
                return SeriesLayout.noSpatial(0, 0, 0, null, null, List.of());
            }
        }
        return storage.seriesLayout(studyUid, seriesUid);
    }

    /**
     * 範囲外パディング用ブランク DICOM を生成して返す。複数スキャン混在シリーズで、ある C/T が覆わない
     * Z 位置を物理座標に揃えて埋めるために frontend が wadouri で読む。
     * {@code ipp}（"x,y,z"）でブランクの ImagePositionPatient を指定（穴の物理位置）。
     * <ul>
     *   <li>web: {@link WebDicomDataService#blankDicom}（必須タグ（患者関係・UID・Image 属性）のみ引き継ぐ）。</li>
     *   <li>standalone: {@link DicomStorageService#blankDicom}（ローカル索引の代表インスタンスを複製）。</li>
     * </ul>
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
        WebDicomDataService web = webProvider.getIfAvailable();
        byte[] dicom = web != null ? web.blankDicom(studyUid, seriesUid, pos) : storage.blankDicom(studyUid, seriesUid, pos);
        if (dicom == null) {
            return org.springframework.http.ResponseEntity.notFound().build();
        }
        return org.springframework.http.ResponseEntity.ok()
                .contentType(org.springframework.http.MediaType.parseMediaType("application/dicom"))
                .header(org.springframework.http.HttpHeaders.CACHE_CONTROL, "private, max-age=3600")
                .body(dicom);
    }

    /**
     * web: シリーズ全インスタンスを WADO-RS で 1 リクエスト一括取得して BFF キャッシュに載せる（prefetch）。
     * MPR/3D/Slicer 等がボリューム構築前に呼ぶと、以降のスライス取得がキャッシュ即返しで高速化する。
     * standalone は no-op（ローカル索引から直接読むため不要）。
     */
    @PostMapping("/studies/{studyUid}/series/{seriesUid}/prefetch")
    public Map<String, Integer> prefetch(@PathVariable String studyUid, @PathVariable String seriesUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        int cached = 0;
        if (web != null) {
            try {
                cached = web.prefetchSeries(studyUid, seriesUid);
            } catch (Exception e) {
                cached = 0; // prefetch は最適化のため、失敗しても個別取得にフォールバックできる
            }
        }
        return Map.of("cached", cached);
    }

    @GetMapping("/studies/{studyUid}/series/{seriesUid}/instances")
    public List<InstanceDto> instances(@PathVariable String studyUid, @PathVariable String seriesUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            // QIDO はインスタンスの並びを保証しないため InstanceNumber 昇順に整える
            // （web レイアウトは空＝単一次元フォールバックのため、この順がスライス送り順になる）。
            return web.searchInstances(studyUid, seriesUid, Map.of()).stream()
                    .map(StudyController::instanceOf)
                    .sorted(Comparator.comparingInt(
                            (InstanceDto i) -> i.instanceNumber() == null ? 0 : i.instanceNumber()))
                    .toList();
        }
        return storage.listInstances(studyUid, seriesUid);
    }

    /**
     * インスタンス本体（Part-10 DICOM）を返す。フロントは {@code wadouri:.../instances/{sop}/file} で読む。
     * <ul>
     *   <li>web: {@link WebDicomDataService#retrieveInstance} が PACS の WADO-RS から取得（BFF）。</li>
     *   <li>standalone: ローカル索引のファイルを返す（study/series は無視し sop で解決）。</li>
     * </ul>
     * standalone は既存の {@code /api/instances/{sop}/file}（{@link InstanceController}）も使えるが、
     * web は WADO-RS が study/series/sop を要するため、この study/series 付き URL を共通の入口にする。
     */
    @GetMapping("/studies/{studyUid}/series/{seriesUid}/instances/{sopUid}/file")
    public ResponseEntity<byte[]> instanceFile(@PathVariable String studyUid,
            @PathVariable String seriesUid, @PathVariable String sopUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        byte[] dicom;
        if (web != null) {
            dicom = web.retrieveInstance(studyUid, seriesUid, sopUid);
        } else {
            Path path = storage.resolveInstanceFile(sopUid);
            if (path == null) {
                return ResponseEntity.notFound().build();
            }
            try {
                dicom = Files.readAllBytes(path);
            } catch (IOException e) {
                return ResponseEntity.notFound().build();
            }
        }
        if (dicom == null || dicom.length == 0) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/dicom"))
                .header(HttpHeaders.CACHE_CONTROL, "private, max-age=3600")
                .body(dicom);
    }

    /**
     * TagViewer: 単一インスタンスの DICOM 属性ダンプ（Read only）。
     * <ul>
     *   <li>web: {@link WebDicomDataService#retrieveInstance} で WADO-RS 取得したバイト列をダンプ。</li>
     *   <li>standalone: ローカル索引のファイルをダンプ（study/series は無視し sop で解決）。</li>
     * </ul>
     * {@link com.vis.graphynext.tagview.TagDumpController}（{@code /api/instances/{sop}/tags}）は
     * standalone 専用のため、web でも動く共通の入口としてこちらを使う。
     */
    @GetMapping("/studies/{studyUid}/series/{seriesUid}/instances/{sopUid}/tags")
    public ResponseEntity<List<TagDumpService.TagRow>> instanceTags(@PathVariable String studyUid,
            @PathVariable String seriesUid, @PathVariable String sopUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        List<TagDumpService.TagRow> rows = web != null
                ? tagDump.dump(web.retrieveInstance(studyUid, seriesUid, sopUid))
                : tagDump.dump(sopUid);
        if (rows == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(rows);
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
