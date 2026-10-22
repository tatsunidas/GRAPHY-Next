/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 条件一致シリーズの抽出（GRAPHY SeriesConditionExtractor 移植）。検証（一致プレビュー）・データシート CSV・
 * standalone のフォルダコピー／ZIP 出力を行う。探索はシリーズ UID 単位で、画像でないデータ（SR/KO/PR/PDF）や
 * 位置決め像・読めないファイルが混ざっていても、読める通常画像のヘッダを探して続行する。
 */
@Service
public class SeriesExtractService {

    private static final Logger log = LoggerFactory.getLogger(SeriesExtractService.class);

    private final DicomInstanceRepository repo;
    private final ObjectProvider<WebDicomDataService> webProvider;
    private final StorageLayout layout;

    public SeriesExtractService(DicomInstanceRepository repo, ObjectProvider<WebDicomDataService> webProvider,
                                StorageLayout layout) {
        this.repo = repo;
        this.webProvider = webProvider;
        this.layout = layout;
    }

    /** 進捗の受け口。total は数え終わったとき 1 回、advance は 1 シリーズ処理するたびに呼ぶ。 */
    public interface Progress {
        Progress NONE = new Progress() {
            @Override
            public void total(int n) {
            }

            @Override
            public void advance(int processed) {
            }

            @Override
            public boolean cancelled() {
                return false;
            }
        };

        void total(int n);

        void advance(int processed);

        boolean cancelled();
    }

    /** 中止されたとき投げる。 */
    public static class CancelledException extends RuntimeException {
        public CancelledException() {
            super("cancelled");
        }
    }

    /** 一致した 1 シリーズ。conditionValues は条件の並びに対応する実測値（データシート用）。 */
    public record SeriesMatch(String studyUid, String seriesUid, String patientId, String studyDate,
                              String seriesDescription, String modality, int instances, String folderName,
                              String seriesNumber, String plane, List<String> conditionValues) {
    }

    /** 検証結果。 */
    public record VerifyResult(List<SeriesMatch> matched, int studyCount, int seriesCount, List<String> errors) {
    }

    /** コピー結果。 */
    public record CopyResult(int copiedSeries, int copiedFiles, List<String> folders, List<String> errors) {
    }

    private record SeriesRef(String studyUid, String seriesUid) {
    }

    /** 評価に使う代表ヘッダと、そのシリーズの枚数。 */
    private record Sample(Attributes header, int instances) {
    }

    // 画像でない SOP クラス（GRAPHY GDicomTools.isSecondaryCaptureOrNonImage 準拠）。
    private static final List<String> NON_IMAGE_SOP_PREFIX = List.of(
            "1.2.840.10008.5.1.4.1.1.7",    // SC
            "1.2.840.10008.5.1.4.1.1.88",   // SR / KO
            "1.2.840.10008.5.1.4.1.1.11",   // PR
            "1.2.840.10008.5.1.4.1.1.104"); // Encapsulated PDF
    /** 代表ヘッダを探すとき、読めないものを何枚まで飛ばすか。 */
    private static final int MAX_HEADER_ATTEMPTS = 10;

    static boolean isNonImageSop(String sopClassUid) {
        if (sopClassUid == null) {
            return true;
        }
        String u = sopClassUid.trim();
        for (String p : NON_IMAGE_SOP_PREFIX) {
            if (u.startsWith(p)) {
                return true;
            }
        }
        return false;
    }

    /** 画素を持つ通常画像のヘッダか（Rows/Columns があり、位置決め像でない）。 */
    static boolean isPlainImageHeader(Attributes h) {
        if (h == null || !h.contains(Tag.Rows) || !h.contains(Tag.Columns)) {
            return false;
        }
        String[] type = h.getStrings(Tag.ImageType);
        if (type != null) {
            for (String t : type) {
                if ("LOCALIZER".equalsIgnoreCase(t)) {
                    return false;
                }
            }
        }
        return true;
    }

    // --- 検証（一致プレビュー） ---

    public VerifyResult verify(List<String> studyUids, List<SearchCondition> conditions, List<String> planes) {
        return verify(studyUids, conditions, planes, Progress.NONE);
    }

    @Transactional(readOnly = true)
    public VerifyResult verify(List<String> studyUids, List<SearchCondition> conditions, List<String> planes,
                               Progress progress) {
        List<SeriesMatch> matched = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        Set<String> studies = new LinkedHashSet<>();
        WebDicomDataService web = webProvider.getIfAvailable();

        // シリーズ UID 単位に展開してから順に処理する（総数が分かるので進捗が出せる）。
        List<SeriesRef> refs = new ArrayList<>();
        for (String studyUid : studyUids) {
            if (studyUid == null || studyUid.isBlank()) {
                continue;
            }
            try {
                if (web != null) {
                    for (Attributes seAttr : web.searchSeries(studyUid, Map.of())) {
                        String uid = seAttr.getString(Tag.SeriesInstanceUID);
                        if (uid != null) {
                            refs.add(new SeriesRef(studyUid, uid));
                        }
                    }
                } else {
                    for (DicomInstanceRepository.SeriesSummary se : repo.findSeriesSummaries(studyUid)) {
                        refs.add(new SeriesRef(studyUid, se.getSeriesInstanceUid()));
                    }
                }
            } catch (Exception e) {
                errors.add("study " + studyUid + ": " + e.getMessage());
            }
        }
        progress.total(refs.size());

        int done = 0;
        for (SeriesRef ref : refs) {
            if (progress.cancelled()) {
                throw new CancelledException();
            }
            try {
                Sample sample = web != null ? sampleWeb(web, ref) : sampleLocal(ref);
                if (sample == null) {
                    errors.add("series " + ref.seriesUid() + ": 読める画像がありません");
                } else if (SeriesConditionEvaluator.matches(sample.header(), conditions, planes)) {
                    matched.add(toMatch(sample.header(), ref.studyUid(), ref.seriesUid(), sample.instances(),
                            conditions));
                    studies.add(ref.studyUid());
                }
            } catch (Exception e) {
                // 1 シリーズの失敗で全体を止めない。
                errors.add("series " + ref.seriesUid() + ": " + e.getMessage());
            }
            progress.advance(++done);
        }
        return new VerifyResult(matched, studies.size(), matched.size(), errors);
    }

    /** 通常画像の読めるヘッダを探す。無ければ画像でないものの読めるヘッダ（それしかないシリーズ用）。 */
    private Sample sampleLocal(SeriesRef ref) {
        List<DicomInstance> insts = repo.findBySeries(ref.studyUid(), ref.seriesUid());
        if (insts.isEmpty()) {
            return null;
        }
        Attributes fallback = null;
        int attempts = 0;
        for (DicomInstance inst : insts) {
            if (attempts >= MAX_HEADER_ATTEMPTS) {
                break;
            }
            attempts++;
            Attributes h = readHeader(inst);
            if (h == null) {
                continue;
            }
            if (!isNonImageSop(inst.getSopClassUid()) && isPlainImageHeader(h)) {
                return new Sample(h, insts.size());
            }
            if (fallback == null) {
                fallback = h;
            }
        }
        return fallback == null ? null : new Sample(fallback, insts.size());
    }

    private Sample sampleWeb(WebDicomDataService web, SeriesRef ref) {
        List<Attributes> insts = web.seriesMetadata(ref.studyUid(), ref.seriesUid());
        if (insts == null || insts.isEmpty()) {
            return null;
        }
        Attributes fallback = null;
        for (Attributes a : insts) {
            if (!isNonImageSop(a.getString(Tag.SOPClassUID)) && isPlainImageHeader(a)) {
                return new Sample(a, insts.size());
            }
            if (fallback == null) {
                fallback = a;
            }
        }
        return new Sample(fallback, insts.size());
    }

    private static SeriesMatch toMatch(Attributes header, String studyUid, String seriesUid, int instances,
                                       List<SearchCondition> conditions) {
        List<String> values = new ArrayList<>();
        if (conditions != null) {
            for (SearchCondition c : conditions) {
                values.add(TagExtractService.resolvePath(header, c.segments()));
            }
        }
        return new SeriesMatch(
                studyUid, seriesUid,
                nz(header.getString(Tag.PatientID)),
                nz(header.getString(Tag.StudyDate)),
                nz(header.getString(Tag.SeriesDescription)),
                nz(header.getString(Tag.Modality)),
                instances,
                folderName(header, seriesUid),
                nz(header.getString(Tag.SeriesNumber)),
                nz(PlaneUtil.planeOf(header)),
                values);
    }

    // --- データシート CSV ---

    /**
     * 必須列（先頭）: PatientID, StudyDate, StudyInstanceUID, SeriesInstanceUID。以降は補助列と、
     * 条件に使ったタグの実測値。UTF-8 BOM 付き（Excel で文字化けしない）。
     */
    public static String datasheetCsv(List<SeriesMatch> matched, List<SearchCondition> conditions) {
        StringBuilder sb = new StringBuilder("﻿");
        List<String> head = new ArrayList<>(List.of("PatientID", "StudyDate", "StudyInstanceUID",
                "SeriesInstanceUID", "Modality", "SeriesNumber", "SeriesDescription", "Instances", "Plane",
                "FolderName"));
        if (conditions != null) {
            for (SearchCondition c : conditions) {
                head.add(c.label() != null && !c.label().isBlank() ? c.label() : labelOf(c));
            }
        }
        sb.append(csvRow(head));
        for (SeriesMatch m : matched) {
            List<String> row = new ArrayList<>(List.of(m.patientId(), m.studyDate(), m.studyUid(), m.seriesUid(),
                    m.modality(), m.seriesNumber(), m.seriesDescription(), String.valueOf(m.instances()), m.plane(),
                    m.folderName()));
            row.addAll(m.conditionValues());
            sb.append(csvRow(row));
        }
        return sb.toString();
    }

    private static String labelOf(SearchCondition c) {
        StringBuilder sb = new StringBuilder();
        for (TagExtractService.Seg s : c.segments()) {
            if (sb.length() > 0) {
                sb.append('.');
            }
            sb.append(s.tag());
        }
        return sb.toString();
    }

    private static String csvRow(List<String> cells) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < cells.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(csvCell(cells.get(i)));
        }
        return sb.append("\r\n").toString();
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
        return copyToFolder(studyUids, conditions, planes, destination, sequentialRename, Progress.NONE);
    }

    /** 進捗は「検証したシリーズ数」＋「コピーしたシリーズ数」を合わせて数える（総数は検証の総数の 2 倍に近い）。 */
    public CopyResult copyToFolder(List<String> studyUids, List<SearchCondition> conditions, List<String> planes,
                                   String destination, boolean sequentialRename, Progress progress)
            throws IOException {
        if (webProvider.getIfAvailable() != null) {
            throw new IllegalStateException("フォルダコピーは standalone 専用です（web は ZIP を使用）。");
        }
        Path dest = validateDestination(destination);
        int[] scanTotal = {0};
        VerifyResult vr = verify(studyUids, conditions, planes, new Progress() {
            @Override
            public void total(int n) {
                scanTotal[0] = n;
                progress.total(n * 2);
            }

            @Override
            public void advance(int processed) {
                progress.advance(processed);
            }

            @Override
            public boolean cancelled() {
                return progress.cancelled();
            }
        });
        List<String> errors = new ArrayList<>(vr.errors());

        // フォルダ名の衝突回避（連番 OFF 時）。連番 ON はあとで 001.. にリネーム。
        Set<String> used = new LinkedHashSet<>();
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
        int copiedSeries = 0;
        for (SeriesMatch m : vr.matched()) {
            if (progress.cancelled()) {
                throw new CancelledException();
            }
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
            copiedSeries++;
            // 一致が 0 件以外なら、コピー側の進捗を総数の後半へ割り当てる。
            progress.advance(scanTotal[0] + (int) Math.round((double) copiedSeries / vr.matched().size() * scanTotal[0]));
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
        // データシートは出力先にも置く（患者 ID・日付・UID が入っているので、フォルダ名と突き合わせられる）。
        Files.writeString(uniqueFile(dest, "series_datasheet.csv"), datasheetCsv(vr.matched(), conditions),
                StandardCharsets.UTF_8);
        log.info("SeriesExtractor copy: {} シリーズ / {} ファイル -> {}", createdFolders.size(), copiedFiles, dest);
        return new CopyResult(createdFolders.size(), copiedFiles, folderNames, errors);
    }

    // --- ZIP（standalone のローカルファイルを ZIP 化） ---

    /** 書き出す前に件数を数える（ストリーミング応答は途中で失敗しても HTTP 200 になるため、0 件はここで弾く）。 */
    public int countMatched(List<String> studyUids, List<SearchCondition> conditions, List<String> planes) {
        return verify(studyUids, conditions, planes).seriesCount();
    }

    public void zipLocal(List<String> studyUids, List<SearchCondition> conditions, List<String> planes,
                         boolean sequentialRename, OutputStream out) throws IOException {
        VerifyResult vr = verify(studyUids, conditions, planes);
        Set<String> used = new LinkedHashSet<>();
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
            zos.putNextEntry(new ZipEntry("series_datasheet.csv"));
            zos.write(datasheetCsv(vr.matched(), conditions).getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
        }
    }

    /** web モードか（ZIP は WADO-RS 取得の実装が必要で未対応）。 */
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

    private Path fileOf(DicomInstance inst) {
        return layout.resolveForRead(inst);
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
        if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
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
