/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import com.vis.graphynext.export.ExportNaming;
import com.vis.graphynext.extract.TagExtractService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 条件一致シリーズの抽出（GRAPHY SeriesConditionExtractor 移植）。検証（一致プレビュー）と、
 * standalone のフォルダコピー／ZIP 出力を行う。
 */
@Service
public class SeriesExtractService {

    private static final Logger log = LoggerFactory.getLogger(SeriesExtractService.class);

    private final DicomInstanceRepository repo;
    private final ObjectProvider<WebDicomDataService> webProvider;

    public SeriesExtractService(DicomInstanceRepository repo, ObjectProvider<WebDicomDataService> webProvider) {
        this.repo = repo;
        this.webProvider = webProvider;
    }

    /** 一致した 1 シリーズ。 */
    public record SeriesMatch(String studyUid, String seriesUid, String patientId, String studyDate,
                              String seriesDescription, String modality, int instances, String folderName) {
    }

    /** 検証結果。 */
    public record VerifyResult(List<SeriesMatch> matched, int studyCount, int seriesCount, List<String> errors) {
    }

    /** コピー結果。 */
    public record CopyResult(int copiedSeries, int copiedFiles, List<String> folders, List<String> errors) {
    }

    // --- 検証（一致プレビュー） ---

    @Transactional(readOnly = true)
    public VerifyResult verify(List<String> studyUids, List<SearchCondition> conditions, List<String> planes) {
        List<SeriesMatch> matched = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        java.util.Set<String> studies = new java.util.LinkedHashSet<>();
        WebDicomDataService web = webProvider.getIfAvailable();

        for (String studyUid : studyUids) {
            if (studyUid == null || studyUid.isBlank()) {
                continue;
            }
            try {
                if (web != null) {
                    verifyStudyWeb(web, studyUid, conditions, planes, matched, studies, errors);
                } else {
                    verifyStudyLocal(studyUid, conditions, planes, matched, studies, errors);
                }
            } catch (Exception e) {
                errors.add("study " + studyUid + ": " + e.getMessage());
            }
        }
        return new VerifyResult(matched, studies.size(), matched.size(), errors);
    }

    private void verifyStudyLocal(String studyUid, List<SearchCondition> conditions, List<String> planes,
                                  List<SeriesMatch> matched, java.util.Set<String> studies, List<String> errors) {
        for (DicomInstanceRepository.SeriesSummary se : repo.findSeriesSummaries(studyUid)) {
            String seriesUid = se.getSeriesInstanceUid();
            try {
                List<DicomInstance> insts = repo.findBySeries(studyUid, seriesUid);
                DicomInstance rep = TagExtractService.pickRepresentative(insts);
                if (rep == null) {
                    continue;
                }
                Attributes header = readHeader(rep);
                if (header == null) {
                    errors.add("series " + seriesUid + ": ヘッダ読取失敗");
                    continue;
                }
                if (SeriesConditionEvaluator.matches(header, conditions, planes)) {
                    matched.add(toMatch(header, studyUid, seriesUid, insts.size()));
                    studies.add(studyUid);
                }
            } catch (Exception e) {
                errors.add("series " + seriesUid + ": " + e.getMessage());
            }
        }
    }

    private void verifyStudyWeb(WebDicomDataService web, String studyUid, List<SearchCondition> conditions,
                                List<String> planes, List<SeriesMatch> matched, java.util.Set<String> studies,
                                List<String> errors) {
        for (Attributes seAttr : web.searchSeries(studyUid, Map.of())) {
            String seriesUid = seAttr.getString(Tag.SeriesInstanceUID);
            if (seriesUid == null) {
                continue;
            }
            try {
                List<Attributes> insts = web.seriesMetadata(studyUid, seriesUid);
                Attributes header = TagExtractService.pickRepresentativeAttrs(insts);
                if (header == null) {
                    continue;
                }
                if (SeriesConditionEvaluator.matches(header, conditions, planes)) {
                    matched.add(toMatch(header, studyUid, seriesUid, insts.size()));
                    studies.add(studyUid);
                }
            } catch (Exception e) {
                errors.add("series " + seriesUid + ": " + e.getMessage());
            }
        }
    }

    private static SeriesMatch toMatch(Attributes header, String studyUid, String seriesUid, int instances) {
        return new SeriesMatch(
                studyUid, seriesUid,
                nz(header.getString(Tag.PatientID)),
                nz(header.getString(Tag.StudyDate)),
                nz(header.getString(Tag.SeriesDescription)),
                nz(header.getString(Tag.Modality)),
                instances,
                folderName(header, seriesUid));
    }

    /** GRAPHY 命名: PatientID_StudyDate_Protocol(or SeriesDescription)_<SeriesUID末尾4>。OS 禁則は無害化。 */
    private static String folderName(Attributes header, String seriesUid) {
        String pid = blankTo(header.getString(Tag.PatientID), "NoPatient");
        String date = blankTo(header.getString(Tag.StudyDate), "NoDate");
        String protocol = header.getString(Tag.ProtocolName);
        if (protocol == null || protocol.isBlank()) {
            protocol = header.getString(Tag.SeriesDescription);
        }
        protocol = blankTo(protocol, "NoProtocol");
        String suffix = (seriesUid != null && seriesUid.length() > 4)
                ? seriesUid.substring(seriesUid.length() - 4) : "0000";
        String raw = pid + "_" + date + "_" + protocol + "_" + suffix;
        return ExportNaming.safeName(raw, "series_" + suffix);
    }

    // --- コピー（standalone のみ） ---

    public CopyResult copyToFolder(List<String> studyUids, List<SearchCondition> conditions, List<String> planes,
                                   String destination, boolean sequentialRename) throws IOException {
        if (webProvider.getIfAvailable() != null) {
            throw new IllegalStateException("フォルダコピーは standalone 専用です（web は ZIP を使用）。");
        }
        Path dest = validateDestination(destination);
        VerifyResult vr = verify(studyUids, conditions, planes);
        List<String> errors = new ArrayList<>(vr.errors());

        // フォルダ名の衝突回避（連番 OFF 時）。連番 ON はあとで 001.. にリネーム。
        java.util.Set<String> used = new java.util.LinkedHashSet<>();
        // 連番 ON の事前衝突チェック。
        if (sequentialRename) {
            for (int i = 1; i <= vr.matched().size(); i++) {
                if (Files.exists(dest.resolve(String.format("%03d", i)))) {
                    throw new IOException("連番フォルダ " + String.format("%03d", i) + " が既に存在します。");
                }
            }
        }

        List<Path> createdFolders = new ArrayList<>();
        int copiedFiles = 0;
        for (SeriesMatch m : vr.matched()) {
            String name = ExportNaming.unique(m.folderName(), used);
            Path seriesDir = dest.resolve(name);
            try {
                Files.createDirectories(seriesDir);
                for (DicomInstance inst : repo.findBySeries(m.studyUid(), m.seriesUid())) {
                    Path src = fileOf(inst);
                    if (src == null) {
                        continue;
                    }
                    Files.copy(src, seriesDir.resolve(src.getFileName().toString()),
                            StandardCopyOption.REPLACE_EXISTING);
                    copiedFiles++;
                }
                createdFolders.add(seriesDir);
            } catch (IOException e) {
                errors.add("copy " + m.seriesUid() + ": " + e.getMessage());
            }
        }

        List<String> folderNames = new ArrayList<>();
        if (sequentialRename) {
            Path csv = uniqueFile(dest, "mapping_table.csv");
            StringBuilder sb = new StringBuilder("OriginalFolderName,SequentialFolderName\n");
            for (int i = 0; i < createdFolders.size(); i++) {
                Path orig = createdFolders.get(i);
                String seq = String.format("%03d", i + 1);
                Path target = dest.resolve(seq);
                try {
                    Files.move(orig, target);
                    sb.append(csvCell(orig.getFileName().toString())).append(',').append(seq).append('\n');
                    folderNames.add(seq);
                } catch (IOException e) {
                    sb.append(csvCell(orig.getFileName().toString())).append(",RENAME_FAILED_").append(seq).append('\n');
                    errors.add("rename " + orig.getFileName() + ": " + e.getMessage());
                }
            }
            Files.writeString(csv, sb.toString());
        } else {
            Path csv = uniqueFile(dest, "extracted_series_list.csv");
            StringBuilder sb = new StringBuilder("ExtractedFolderName\n");
            for (Path f : createdFolders) {
                sb.append(csvCell(f.getFileName().toString())).append('\n');
                folderNames.add(f.getFileName().toString());
            }
            Files.writeString(csv, sb.toString());
        }
        log.info("SeriesExtractor copy: {} シリーズ / {} ファイル -> {}", createdFolders.size(), copiedFiles, dest);
        return new CopyResult(createdFolders.size(), copiedFiles, folderNames, errors);
    }

    // --- ZIP（standalone のローカルファイルを ZIP 化） ---

    public void zipLocal(List<String> studyUids, List<SearchCondition> conditions, List<String> planes,
                         boolean sequentialRename, OutputStream out) throws IOException {
        VerifyResult vr = verify(studyUids, conditions, planes);
        java.util.Set<String> used = new java.util.LinkedHashSet<>();
        try (ZipOutputStream zos = new ZipOutputStream(out)) {
            int idx = 0;
            for (SeriesMatch m : vr.matched()) {
                idx++;
                String folder = sequentialRename ? String.format("%03d", idx)
                        : ExportNaming.unique(m.folderName(), used);
                for (DicomInstance inst : repo.findBySeries(m.studyUid(), m.seriesUid())) {
                    Path src = fileOf(inst);
                    if (src == null) {
                        continue;
                    }
                    zos.putNextEntry(new ZipEntry(folder + "/" + src.getFileName()));
                    Files.copy(src, zos);
                    zos.closeEntry();
                }
            }
        }
    }

    /** web モードで ZIP 可能か（WADO-RS 取得の実装が必要）。現状は未対応を明示。 */
    public boolean isWeb() {
        return webProvider.getIfAvailable() != null;
    }

    // --- helpers ---

    private static Path validateDestination(String destination) throws IOException {
        if (destination == null || destination.isBlank()) {
            throw new IOException("出力先フォルダが指定されていません。");
        }
        Path p = Path.of(destination);
        if (!p.isAbsolute()) {
            throw new IOException("出力先は絶対パスで指定してください: " + destination);
        }
        Files.createDirectories(p);
        if (!Files.isDirectory(p)) {
            throw new IOException("出力先がディレクトリではありません: " + destination);
        }
        return p;
    }

    private static Path fileOf(DicomInstance inst) {
        String uri = inst.getUri();
        if (uri == null || !uri.startsWith("file:")) {
            return null;
        }
        try {
            Path p = Path.of(java.net.URI.create(uri));
            return Files.exists(p) ? p : null;
        } catch (Exception e) {
            return null;
        }
    }

    private Attributes readHeader(DicomInstance inst) {
        Path p = fileOf(inst);
        if (p == null) {
            return null;
        }
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDatasetUntilPixelData();
        } catch (IOException e) {
            log.warn("series-extract: header 読取失敗 {}", inst.getSopInstanceUid(), e);
            return null;
        }
    }

    private static Path uniqueFile(Path dir, String fileName) {
        Path f = dir.resolve(fileName);
        if (!Files.exists(f)) {
            return f;
        }
        int dot = fileName.lastIndexOf('.');
        String base = dot >= 0 ? fileName.substring(0, dot) : fileName;
        String ext = dot >= 0 ? fileName.substring(dot) : "";
        int n = 1;
        while (Files.exists(f)) {
            f = dir.resolve(base + "_" + n + ext);
            n++;
        }
        return f;
    }

    private static String csvCell(String s) {
        if (s == null) {
            return "";
        }
        if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0) {
            return '"' + s.replace("\"", "\"\"") + '"';
        }
        return s;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static String blankTo(String s, String fallback) {
        return (s == null || s.isBlank()) ? fallback : s.trim();
    }
}
