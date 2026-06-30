/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.ElementDictionary;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * 指定タグ群をローカル索引のインスタンスから一括抽出する（TagExtractor ツール）。
 *
 * <p>各インスタンスのヘッダ（ピクセル無し）を読み、要求されたタグ番号の文字列値を取り出して
 * 表形式（列=識別子＋要求タグ, 行=インスタンス）で返す。CSV/JSON への整形は呼び出し側。
 * dcm4che のデータディクショナリで列見出しにキーワードを併記する。
 */
@Service
public class TagExtractService {

    private static final Logger log = LoggerFactory.getLogger(TagExtractService.class);

    /** マルチ値の区切り（DICOM の VM 区切りに合わせる）。 */
    private static final String MULTI_VALUE_DELIM = "\\";

    /** 行に常に付与する識別子列（ヘッダ読取不要・索引から取得）。 */
    private static final List<String> ID_COLUMNS =
            List.of("StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID", "InstanceNumber");

    private final DicomInstanceRepository repo;

    public TagExtractService(DicomInstanceRepository repo) {
        this.repo = repo;
    }

    /** 抽出結果（列見出し＋行）。 */
    public record ExtractResult(List<String> columns, List<List<String>> rows) {}

    /**
     * studyUid（必須）と seriesUid（null ならスタディ全体）の範囲で tags を抽出する。
     *
     * @param tags 8 桁 16 進のタグ番号（例 "00100010"）。区切り/括弧などは無視して正規化。
     */
    @Transactional(readOnly = true)
    public ExtractResult extract(String studyUid, String seriesUid, List<String> tags) {
        List<int[]> parsed = new ArrayList<>();
        List<String> tagColumns = new ArrayList<>();
        ElementDictionary dict = ElementDictionary.getStandardElementDictionary();
        for (String raw : tags) {
            String hex = raw == null ? "" : raw.replaceAll("[^0-9A-Fa-f]", "");
            if (hex.length() != 8) {
                continue; // 不正タグはスキップ
            }
            int tag = (int) Long.parseLong(hex, 16);
            parsed.add(new int[] {tag});
            String keyword = dict.keywordOf(tag);
            String upper = hex.toUpperCase();
            tagColumns.add((keyword == null || keyword.isEmpty()) ? upper : keyword + " (" + upper + ")");
        }

        List<String> columns = new ArrayList<>(ID_COLUMNS);
        columns.addAll(tagColumns);

        List<DicomInstance> instances = (seriesUid == null || seriesUid.isBlank())
                ? repo.findByStudyInstanceUid(studyUid)
                : repo.findBySeries(studyUid, seriesUid);
        // InstanceNumber 昇順（findByStudyInstanceUid は未ソートのため明示的に整列）
        instances.sort(Comparator.comparingInt(i -> i.getInstanceNumber() == null ? 0 : i.getInstanceNumber()));

        List<List<String>> rows = new ArrayList<>();
        for (DicomInstance inst : instances) {
            Attributes ds = readHeaderQuietly(inst);
            List<String> row = new ArrayList<>(columns.size());
            row.add(nullToEmpty(inst.getStudyInstanceUid()));
            row.add(nullToEmpty(inst.getSeriesInstanceUid()));
            row.add(nullToEmpty(inst.getSopInstanceUid()));
            row.add(inst.getInstanceNumber() == null ? "" : String.valueOf(inst.getInstanceNumber()));
            for (int[] t : parsed) {
                row.add(ds == null ? "" : tagValue(ds, t[0]));
            }
            rows.add(row);
        }
        return new ExtractResult(columns, rows);
    }

    private static String tagValue(Attributes ds, int tag) {
        if (!ds.contains(tag)) {
            return "";
        }
        String[] vals = ds.getStrings(tag);
        if (vals == null || vals.length == 0) {
            return nullToEmpty(ds.getString(tag));
        }
        return String.join(MULTI_VALUE_DELIM, vals);
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
}
