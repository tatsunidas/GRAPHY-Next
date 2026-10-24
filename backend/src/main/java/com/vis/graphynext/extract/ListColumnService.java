/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import com.vis.graphynext.extract.TagExtractService.Seg;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * スタディ一覧・シリーズ一覧に、利用者が選んだ DICOM タグの列を出すための値の読み取り（読むだけ）。
 *
 * <p>値は索引にも DICOM ファイルにも書かない。表示する行のぶんだけ、シリーズの代表インスタンス
 * （{@link TagExtractService#pickRepresentative}）のヘッダからそのつど読み、読んだ値はメモリに覚える。
 * 値の取り方は {@link TagExtractService#resolvePath} と同じなので、TagExtractor の表と同じ値になる。
 *
 * <p>覚えておく鍵は「代表の SOP UID・ファイルの大きさ・更新時刻・タグの指定」。タグ編集や患者情報の編集は
 * ファイルを入れ替える（大きさか更新時刻が変わる）ので、古い値は鍵が合わず使われない。
 *
 * <p>Drive が正本のモード A で手元に無いファイルは取り寄せない（一覧を眺めただけでダウンロードが走るのを避ける）。
 * その行は {@link State#NOT_LOCAL}。
 */
@Service
public class ListColumnService {

    private static final Logger log = LoggerFactory.getLogger(ListColumnService.class);

    /** セルの状態。値が空文字（タグはある）と、タグが無いことを区別する。 */
    public enum State {
        OK, ABSENT, NOT_LOCAL, UNREADABLE, NOT_RETURNED
    }

    /** 列 1 本。id は呼び出し側が付ける識別子、segments は TagExtractor と同じタグの指定。 */
    public record Column(String id, List<Seg> segments) {
    }

    /**
     * 1 つのセル。{@code values} は重複を除いた空でない値（スタディの行ではシリーズごとの値）。
     * {@code incomplete} は、一部のシリーズだけ読めなかった（値は読めたぶんだけ）ことを表す。
     */
    public record Cell(List<String> values, State state, boolean incomplete) {
    }

    /** 覚えておく 1 件。present=タグがあるか。 */
    private record Cached(boolean present, String value) {
    }

    /** 1 シリーズ・1 列の結果。 */
    private record SeriesCell(String value, State state) {
    }

    /** 覚えておく値の上限（件数）。値が長いものは覚えない（下の MAX_CACHED_VALUE_CHARS）。 */
    static final int MAX_ENTRIES = 20_000;
    /** これより長い値は覚えない（メモリ使用量の上限を件数で言えるようにするため）。毎回読み直す。 */
    static final int MAX_CACHED_VALUE_CHARS = 4096;

    private final DicomInstanceRepository repo;
    private final ObjectProvider<WebDicomDataService> webProvider;
    private final StorageLayout layout;

    private final Map<String, Cached> cache = Collections.synchronizedMap(
            new LinkedHashMap<String, Cached>(256, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Cached> eldest) {
                    return size() > MAX_ENTRIES;
                }
            });

    /** テスト用: ヘッダを実際に読んだ回数（覚えた値を使えたかの確認）。 */
    private final java.util.concurrent.atomic.AtomicLong headerReads = new java.util.concurrent.atomic.AtomicLong();

    public ListColumnService(DicomInstanceRepository repo, ObjectProvider<WebDicomDataService> webProvider,
                             StorageLayout layout) {
        this.repo = repo;
        this.webProvider = webProvider;
        this.layout = layout;
    }

    long headerReadCount() {
        return headerReads.get();
    }

    // --- 入口 ---

    /** スタディごと・列ごとのセル（シリーズごとの値を重複なしでまとめる）。 */
    @Transactional(readOnly = true)
    public Map<String, Map<String, Cell>> studyCells(List<String> studyUids, List<Column> columns) {
        Map<String, Map<String, Cell>> out = new LinkedHashMap<>();
        for (String studyUid : studyUids) {
            if (studyUid == null || studyUid.isBlank()) {
                continue;
            }
            Map<String, Map<String, SeriesCell>> bySeries = seriesCellsOf(studyUid, columns);
            Map<String, Cell> row = new LinkedHashMap<>();
            for (Column c : columns) {
                List<SeriesCell> cells = new ArrayList<>();
                for (Map<String, SeriesCell> s : bySeries.values()) {
                    SeriesCell v = s.get(c.id());
                    if (v != null) {
                        cells.add(v);
                    }
                }
                row.put(c.id(), aggregate(cells));
            }
            out.put(studyUid, row);
        }
        return out;
    }

    /** 1 スタディのシリーズごと・列ごとのセル（シリーズ UID → 列 id → セル）。 */
    @Transactional(readOnly = true)
    public Map<String, Map<String, Cell>> seriesCells(String studyUid, List<Column> columns) {
        Map<String, Map<String, Cell>> out = new LinkedHashMap<>();
        for (Map.Entry<String, Map<String, SeriesCell>> e : seriesCellsOf(studyUid, columns).entrySet()) {
            Map<String, Cell> row = new LinkedHashMap<>();
            for (Column c : columns) {
                SeriesCell v = e.getValue().get(c.id());
                row.put(c.id(), v == null
                        ? new Cell(List.of(), State.UNREADABLE, false)
                        : aggregate(List.of(v)));
            }
            out.put(e.getKey(), row);
        }
        return out;
    }

    private Map<String, Map<String, SeriesCell>> seriesCellsOf(String studyUid, List<Column> columns) {
        WebDicomDataService web = webProvider.getIfAvailable();
        return web != null ? webSeries(web, studyUid, columns) : localSeries(studyUid, columns);
    }

    // --- standalone（ローカル索引＋FS） ---

    private Map<String, Map<String, SeriesCell>> localSeries(String studyUid, List<Column> columns) {
        Map<String, Map<String, SeriesCell>> out = new LinkedHashMap<>();
        for (DicomInstanceRepository.SeriesSummary se : repo.findSeriesSummaries(studyUid)) {
            String seriesUid = se.getSeriesInstanceUid();
            Map<String, SeriesCell> row = new LinkedHashMap<>();
            DicomInstance rep = TagExtractService.pickRepresentative(repo.findBySeries(studyUid, seriesUid));
            if (rep == null) {
                columns.forEach(c -> row.put(c.id(), new SeriesCell("", State.UNREADABLE)));
                out.put(seriesUid, row);
                continue;
            }
            Path path = layout.localPath(rep);
            if (path == null) {
                // 手元に無い。モード A（Drive が正本）なら取り寄せずに ☁、そうでなければファイルが無い。
                State s = layout.cacheMode() ? State.NOT_LOCAL : State.UNREADABLE;
                columns.forEach(c -> row.put(c.id(), new SeriesCell("", s)));
                out.put(seriesUid, row);
                continue;
            }
            String fileKey;
            try {
                BasicFileAttributes at = Files.readAttributes(path, BasicFileAttributes.class);
                fileKey = rep.getSopInstanceUid() + "|" + at.size() + "|" + at.lastModifiedTime().toMillis();
            } catch (IOException e) {
                columns.forEach(c -> row.put(c.id(), new SeriesCell("", State.UNREADABLE)));
                out.put(seriesUid, row);
                continue;
            }
            Attributes header = null;
            boolean readFailed = false;
            for (Column c : columns) {
                String key = fileKey + "|" + pathKey(c.segments());
                Cached hit = cache.get(key);
                if (hit == null) {
                    if (header == null && !readFailed) {
                        try {
                            headerReads.incrementAndGet();
                            header = HeaderReader.read(path);
                        } catch (IOException e) {
                            log.warn("list-column: header 読取失敗 {}", rep.getSopInstanceUid(), e);
                            readFailed = true;
                        }
                    }
                    if (header == null) {
                        row.put(c.id(), new SeriesCell("", State.UNREADABLE));
                        continue;
                    }
                    hit = new Cached(isPresent(header, c.segments()), TagExtractService.resolvePath(header, c.segments()));
                    if (hit.value().length() <= MAX_CACHED_VALUE_CHARS) {
                        cache.put(key, hit);
                    }
                }
                row.put(c.id(), new SeriesCell(hit.value(), hit.present() ? State.OK : State.ABSENT));
            }
            out.put(seriesUid, row);
        }
        return out;
    }

    // --- web（QIDO のシリーズ検索。includefield で必要なタグを求める） ---

    private Map<String, Map<String, SeriesCell>> webSeries(WebDicomDataService web, String studyUid,
                                                               List<Column> columns) {
        Map<String, Map<String, SeriesCell>> out = new LinkedHashMap<>();
        Set<String> fields = new LinkedHashSet<>();
        for (Column c : columns) {
            if (!c.segments().isEmpty()) {
                // シーケンスの中のタグは、先頭の（最上位の）タグを求める。PACS が中身まで返すかは PACS 次第。
                fields.add(c.segments().get(0).tag().replaceAll("[^0-9A-Fa-f]", "").toUpperCase());
            }
        }
        Map<String, String> query = fields.isEmpty() ? Map.of() : Map.of("includefield", String.join(",", fields));
        List<Attributes> series;
        try {
            series = web.searchSeries(studyUid, query);
        } catch (RuntimeException e) {
            log.warn("list-column: QIDO 失敗 study={}", studyUid, e);
            Map<String, SeriesCell> row = new LinkedHashMap<>();
            columns.forEach(c -> row.put(c.id(), new SeriesCell("", State.UNREADABLE)));
            out.put("", row);
            return out;
        }
        for (Attributes a : series) {
            String seriesUid = a.getString(Tag.SeriesInstanceUID);
            if (seriesUid == null) {
                continue;
            }
            Map<String, SeriesCell> row = new LinkedHashMap<>();
            for (Column c : columns) {
                // 返ってこなかったのか、そもそも無いのかは QIDO からは区別できない。「取得できません」の印にする。
                row.put(c.id(), isPresent(a, c.segments())
                        ? new SeriesCell(TagExtractService.resolvePath(a, c.segments()), State.OK)
                        : new SeriesCell("", State.NOT_RETURNED));
            }
            out.put(seriesUid, row);
        }
        return out;
    }

    // --- 共通 ---

    /**
     * シリーズごとのセルをスタディの 1 セルにまとめる。値は重複なしの空でない値。
     * 1 つでも OK があればその値を出し、残りが読めていなければ incomplete。OK が無いときは、読めなかった理由
     * （手元に無い → 読めない → 返らない → タグなし の順）を状態にする。
     */
    private static Cell aggregate(List<SeriesCell> cells) {
        if (cells.isEmpty()) {
            return new Cell(List.of(), State.ABSENT, false);
        }
        Set<String> values = new LinkedHashSet<>();
        boolean anyOk = false;
        boolean incomplete = false;
        boolean notLocal = false;
        boolean unreadable = false;
        boolean notReturned = false;
        for (SeriesCell c : cells) {
            switch (c.state()) {
                case OK -> {
                    anyOk = true;
                    if (!c.value().isEmpty()) {
                        values.add(c.value());
                    }
                }
                case NOT_LOCAL -> {
                    notLocal = true;
                    incomplete = true;
                }
                case UNREADABLE -> {
                    unreadable = true;
                    incomplete = true;
                }
                case NOT_RETURNED -> {
                    notReturned = true;
                    incomplete = true;
                }
                case ABSENT -> {
                }
            }
        }
        if (anyOk) {
            return new Cell(List.copyOf(values), State.OK, incomplete);
        }
        State s = notLocal ? State.NOT_LOCAL : unreadable ? State.UNREADABLE : notReturned ? State.NOT_RETURNED : State.ABSENT;
        return new Cell(List.of(), s, false);
    }

    /** パスの最後のタグがあるか（値が空でもタグがあれば true）。途中の SQ が無ければ false。 */
    static boolean isPresent(Attributes header, List<Seg> segments) {
        if (segments == null || segments.isEmpty()) {
            return false;
        }
        Attributes cur = header;
        for (int j = 0; j < segments.size(); j++) {
            Seg seg = segments.get(j);
            int tag = parseTag(seg.tag());
            if (tag == -1) {
                return false;
            }
            String creator = (seg.creator() == null || seg.creator().isBlank()) ? null : seg.creator();
            if (j == segments.size() - 1) {
                return creator != null ? cur.contains(creator, tag) : cur.contains(tag);
            }
            cur = creator != null ? cur.getNestedDataset(creator, tag) : cur.getNestedDataset(tag);
            if (cur == null) {
                return false;
            }
        }
        return false;
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

    static String pathKey(List<Seg> segments) {
        StringBuilder sb = new StringBuilder();
        for (Seg s : segments) {
            if (sb.length() > 0) {
                sb.append('>');
            }
            sb.append(s.tag() == null ? "" : s.tag().replaceAll("[^0-9A-Fa-f]", "").toLowerCase());
            if (s.creator() != null && !s.creator().isBlank()) {
                sb.append('@').append(s.creator());
            }
        }
        return sb.toString();
    }
}
