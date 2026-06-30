/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.web.WebDicomDataService;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * TagExtractor: タグ／シーケンスタグ（パス）／Private タグを指定し、検索リスト全体に対し<b>シリーズ単位</b>
 * （代表インスタンス 1 枚）で値を取得して表形式にする（GRAPHY 移植）。
 *
 * <p>パスは {@link Seg} のリスト。中間セグメントは SQ として {@code getNestedDataset}（先頭アイテム）で辿り、
 * 末尾で {@code getStrings}（複数値は {@code \} 連結、無ければ {@code getString}）。Private は creator 指定で
 * creator 版、未指定なら raw タグ読み（GRAPHY 互換）。standalone はローカル FS ヘッダ、web は WADO-RS
 * metadata の Attributes を読む。
 */
@Service
public class TagExtractService {

    private static final Logger log = LoggerFactory.getLogger(TagExtractService.class);

    /** マルチ値の区切り（DICOM の VM 区切りに合わせる）。 */
    private static final String MULTI_VALUE_DELIM = "\\";

    /** シリーズ代表として優先しない SOP クラス（SC / KO / PR）。標準画像を優先する。 */
    private static final java.util.Set<String> NON_PREFERRED_SOP = java.util.Set.of(
            "1.2.840.10008.5.1.4.1.1.7",          // Secondary Capture Image Storage
            "1.2.840.10008.5.1.4.1.1.88.59",      // Key Object Selection Document
            "1.2.840.10008.5.1.4.1.1.11.1");      // Grayscale Softcopy Presentation State

    /** 管理列（常時先頭）。 */
    private static final List<String> ADMIN_COLUMNS = List.of(
            "SeriesSource", "PatientID", "AccessionNumber", "Modality", "StudyDate",
            "StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID");

    /** 管理列に対応する DICOM タグ（SeriesSource は別途）。 */
    private static final int[] ADMIN_TAGS = {
            Tag.PatientID, Tag.AccessionNumber, Tag.Modality, Tag.StudyDate,
            Tag.StudyInstanceUID, Tag.SeriesInstanceUID, Tag.SOPInstanceUID};

    private final DicomInstanceRepository repo;
    private final ObjectProvider<WebDicomDataService> webProvider;

    public TagExtractService(DicomInstanceRepository repo, ObjectProvider<WebDicomDataService> webProvider) {
        this.repo = repo;
        this.webProvider = webProvider;
    }

    /** タグパスの 1 セグメント。tag は 8 桁 16 進。creator は Private creator（任意）。 */
    public record Seg(String tag, String creator) {
    }

    /** 抽出する 1 つのタグパス（セグメント列＋表示用ラベル）。 */
    public record TagPath(List<Seg> segments, String label) {
    }

    /** CSV/JSON 整形に渡す結果（列見出し＋行）。 */
    public record ExtractResult(List<String> columns, List<List<String>> rows) {
    }

    /** 画面テーブル用の結果（列＋行＋エラーログ）。 */
    public record TableResult(List<String> columns, List<List<String>> rows, List<String> errors) {
    }

    /**
     * 検索リスト（studyUids）全体に対し、シリーズ単位（代表 1 枚）で paths を抽出する。
     */
    @Transactional(readOnly = true)
    public TableResult extractTable(List<String> studyUids, List<TagPath> paths) {
        List<String> columns = new ArrayList<>(ADMIN_COLUMNS);
        for (TagPath p : paths) {
            columns.add(labelOf(p));
        }
        List<List<String>> rows = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        WebDicomDataService web = webProvider.getIfAvailable();

        for (String studyUid : studyUids) {
            if (studyUid == null || studyUid.isBlank()) {
                continue;
            }
            try {
                if (web != null) {
                    extractStudyWeb(web, studyUid, paths, rows, errors);
                } else {
                    extractStudyLocal(studyUid, paths, rows, errors);
                }
            } catch (Exception e) {
                errors.add("study " + studyUid + ": " + e.getMessage());
            }
        }
        return new TableResult(columns, rows, errors);
    }

    // --- standalone（ローカル索引＋FS） ---

    private void extractStudyLocal(String studyUid, List<TagPath> paths,
                                   List<List<String>> rows, List<String> errors) {
        for (DicomInstanceRepository.SeriesSummary se : repo.findSeriesSummaries(studyUid)) {
            String seriesUid = se.getSeriesInstanceUid();
            try {
                List<DicomInstance> insts = repo.findBySeries(studyUid, seriesUid);
                DicomInstance rep = pickRepresentative(insts);
                if (rep == null) {
                    errors.add("series " + seriesUid + ": インスタンスなし");
                    continue;
                }
                Attributes header = readHeaderQuietly(rep);
                if (header == null) {
                    errors.add("series " + seriesUid + ": ヘッダ読取失敗 (" + rep.getSopInstanceUid() + ")");
                    continue;
                }
                rows.add(buildRow(seriesSource(rep), header, paths));
            } catch (Exception e) {
                errors.add("series " + seriesUid + ": " + e.getMessage());
            }
        }
    }

    /** シリーズ代表インスタンス（非SC/KO/PR を優先、無ければ先頭）。SeriesExtractor 等から再利用。 */
    public static DicomInstance pickRepresentative(List<DicomInstance> insts) {
        if (insts == null || insts.isEmpty()) {
            return null;
        }
        for (DicomInstance i : insts) {
            if (i.getSopClassUid() == null || !NON_PREFERRED_SOP.contains(i.getSopClassUid())) {
                return i;
            }
        }
        return insts.get(0);
    }

    private static String seriesSource(DicomInstance rep) {
        String uri = rep.getUri();
        if (uri != null && uri.startsWith("file:")) {
            try {
                return Path.of(java.net.URI.create(uri)).toString();
            } catch (Exception ignore) {
                // fall through
            }
        }
        return uri == null ? "" : uri;
    }

    // --- web（DICOMweb: QIDO でシリーズ列挙 → WADO-RS metadata） ---

    private void extractStudyWeb(WebDicomDataService web, String studyUid, List<TagPath> paths,
                                 List<List<String>> rows, List<String> errors) {
        for (Attributes seriesAttr : web.searchSeries(studyUid, java.util.Map.of())) {
            String seriesUid = seriesAttr.getString(Tag.SeriesInstanceUID);
            if (seriesUid == null) {
                continue;
            }
            try {
                List<Attributes> insts = web.seriesMetadata(studyUid, seriesUid);
                Attributes header = pickRepresentativeAttrs(insts);
                if (header == null) {
                    errors.add("series " + seriesUid + ": metadata なし");
                    continue;
                }
                rows.add(buildRow("wadors:" + studyUid + "/" + seriesUid, header, paths));
            } catch (Exception e) {
                errors.add("series " + seriesUid + ": " + e.getMessage());
            }
        }
    }

    /** web（WADO metadata）用のシリーズ代表 Attributes（非SC/KO/PR を優先、無ければ先頭）。 */
    public static Attributes pickRepresentativeAttrs(List<Attributes> insts) {
        if (insts == null || insts.isEmpty()) {
            return null;
        }
        for (Attributes a : insts) {
            String sop = a.getString(Tag.SOPClassUID);
            if (sop == null || !NON_PREFERRED_SOP.contains(sop)) {
                return a;
            }
        }
        return insts.get(0);
    }

    // --- 共通: 行生成・パス解決 ---

    private static List<String> buildRow(String seriesSource, Attributes header, List<TagPath> paths) {
        List<String> row = new ArrayList<>();
        row.add(seriesSource);
        for (int tag : ADMIN_TAGS) {
            row.add(nullToEmpty(header.getString(tag)));
        }
        for (TagPath p : paths) {
            row.add(resolvePath(header, p.segments()));
        }
        return row;
    }

    /** パス（中間 SQ を辿り末尾で値）を解決する。未検出/空は ""。SeriesExtractor 等から再利用。 */
    public static String resolvePath(Attributes header, List<Seg> segments) {
        if (segments == null || segments.isEmpty()) {
            return "";
        }
        Attributes cur = header;
        for (int j = 0; j < segments.size(); j++) {
            Seg seg = segments.get(j);
            int tag = parseTag(seg.tag());
            if (tag == -1) {
                return "";
            }
            String creator = (seg.creator() == null || seg.creator().isBlank()) ? null : seg.creator();
            boolean last = j == segments.size() - 1;
            if (last) {
                String[] vals = creator != null ? cur.getStrings(creator, tag) : cur.getStrings(tag);
                if (vals != null && vals.length > 0) {
                    return String.join(MULTI_VALUE_DELIM, java.util.Arrays.stream(vals)
                            .map(v -> v == null ? "" : v).toList());
                }
                String single = creator != null ? cur.getString(creator, tag) : cur.getString(tag);
                return nullToEmpty(single);
            }
            cur = creator != null ? cur.getNestedDataset(creator, tag) : cur.getNestedDataset(tag);
            if (cur == null) {
                return "";
            }
        }
        return "";
    }

    private static int parseTag(String hex) {
        if (hex == null) {
            return -1;
        }
        String h = hex.replaceAll("[^0-9A-Fa-f]", "");
        if (h.length() != 8) {
            return -1;
        }
        try {
            return (int) Long.parseLong(h, 16);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String labelOf(TagPath p) {
        if (p.label() != null && !p.label().isBlank()) {
            return p.label();
        }
        // ラベル未指定: セグメントの hex を "." 連結。
        StringBuilder sb = new StringBuilder();
        for (Seg s : p.segments()) {
            if (sb.length() > 0) {
                sb.append('.');
            }
            sb.append(s.tag());
        }
        return sb.toString();
    }

    private Attributes readHeaderQuietly(DicomInstance inst) {
        Path path = (inst.getUri() != null && inst.getUri().startsWith("file:"))
                ? Path.of(java.net.URI.create(inst.getUri())) : null;
        if (path == null || !Files.exists(path)) {
            return null;
        }
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDatasetUntilPixelData();
        } catch (IOException e) {
            log.warn("tag-extract: header 読取失敗 {}", inst.getSopInstanceUid(), e);
            return null;
        }
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    /** TableResult を CSV/JSON 整形用の ExtractResult に変換する。 */
    public static ExtractResult toExtractResult(TableResult t) {
        return new ExtractResult(t.columns(), t.rows());
    }
}
