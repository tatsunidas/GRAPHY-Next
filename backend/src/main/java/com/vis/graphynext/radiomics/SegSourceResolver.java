/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.dicom.export.SegImportResult;
import com.vis.graphynext.dicom.export.SegReadService;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * スタディの中の SEG を、(元画像シリーズ, セグメント) の組に分ける。
 *
 * <p>元画像は SEG の ReferencedSeriesSequence で特定する。無い・複数・別スタディのときは、同じ
 * FrameOfReferenceUID の画像シリーズを候補に挙げて {@code NEEDS_CONFIRMATION} とし、<b>候補が 1 つでも
 * 自動では確定しない</b>（取り違えると別の画像の特徴量が黙って出るため）。
 *
 * <p>セグメントは {@link SegReadService#readSegments} が返す「前景のあるもの」だけで、
 * {@code maskChannel} はその番号の昇順の添字（{@code RadiomicsMapEngine} が SEG のチャンネルを
 * そう並べるため）。前景のあるセグメントが無い SEG は {@code EXCLUDED} にする。空のマスクを
 * {@code RadiomicsMapEngine} に渡すと全面マスクで計算されるので、ここで必ず止める。
 */
@Component
public class SegSourceResolver {

    /** 元画像の候補にしない Modality（画素を持たない・別の派生物）。 */
    private static final Set<String> NOT_SOURCE = Set.of("SEG", "RTSTRUCT", "SR", "PR", "KO", "REG", "RWV", "DOC");

    record SeriesInfo(String seriesUid, String modality) {}

    record SegHeader(List<String> referencedSeriesUids, String frameOfReferenceUid) {}

    record SegmentInfo(int number, String label) {}

    @FunctionalInterface
    interface SeriesLister {
        List<SeriesInfo> list(String studyUid);
    }

    @FunctionalInterface
    interface HeaderReader {
        /** SEG のヘッダ。ファイルが無い・SEG でないときは null。 */
        SegHeader read(String studyUid, String seriesUid) throws IOException;
    }

    @FunctionalInterface
    interface SegmentReader {
        /** 前景のあるセグメント（番号の昇順）。SEG でなければ空。 */
        List<SegmentInfo> read(String studyUid, String seriesUid) throws IOException;
    }

    @FunctionalInterface
    interface FrameOfReferenceLookup {
        String of(String studyUid, String seriesUid);
    }

    private final SeriesLister series;
    private final HeaderReader headers;
    private final SegmentReader segments;
    private final FrameOfReferenceLookup frames;

    @Autowired
    public SegSourceResolver(DicomInstanceRepository repo, SegReadService segReader, DicomStorageService storage) {
        this(studyUid -> repo.findSeriesSummaries(studyUid).stream()
                        .map(s -> new SeriesInfo(s.getSeriesInstanceUid(), s.getModality())).toList(),
                (studyUid, seriesUid) -> readHeader(storage, studyUid, seriesUid),
                (studyUid, seriesUid) -> {
                    SegImportResult r = segReader.readSegments(studyUid, seriesUid);
                    if (r == null) {
                        return List.of();
                    }
                    return r.segments().stream()
                            .sorted(java.util.Comparator.comparingInt(SegImportResult.Segment::number))
                            .map(s -> new SegmentInfo(s.number(), s.label())).toList();
                },
                (studyUid, seriesUid) -> storage.seriesLayout(studyUid, seriesUid).frameOfReferenceUID());
    }

    SegSourceResolver(SeriesLister series, HeaderReader headers, SegmentReader segments,
                      FrameOfReferenceLookup frames) {
        this.series = series;
        this.headers = headers;
        this.segments = segments;
        this.frames = frames;
    }

    /** 画素の前までを読み、ReferencedSeriesSequence と FrameOfReferenceUID を取る。 */
    private static SegHeader readHeader(DicomStorageService storage, String studyUid, String seriesUid)
            throws IOException {
        List<Path> files = storage.resolveFiles(studyUid, List.of(seriesUid));
        for (Path f : files) {
            Attributes ds;
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                ds = in.readDataset(-1, Tag.PixelData);
            }
            return headerOf(ds);
        }
        return null;
    }

    static SegHeader headerOf(Attributes ds) {
        List<String> refs = new ArrayList<>();
        Sequence seq = ds.getSequence(Tag.ReferencedSeriesSequence);
        if (seq != null) {
            for (Attributes item : seq) {
                String uid = item.getString(Tag.SeriesInstanceUID);
                if (uid != null && !uid.isBlank() && !refs.contains(uid)) {
                    refs.add(uid);
                }
            }
        }
        return new SegHeader(refs, ds.getString(Tag.FrameOfReferenceUID));
    }

    /**
     * スタディごとの組。SEG を読めない場合はその SEG を理由つきの {@code EXCLUDED} 1 件にして続ける
     * （黙って落とさない）。索引の障害など環境側の例外は握らず、呼び出し側へ伝える。
     */
    public List<BatchPair> resolve(List<String> studyUids) {
        List<BatchPair> out = new ArrayList<>();
        for (String studyUid : studyUids) {
            List<SeriesInfo> all = series.list(studyUid);
            List<SeriesInfo> sources = all.stream()
                    .filter(s -> s.modality() == null || !NOT_SOURCE.contains(s.modality())).toList();
            for (SeriesInfo seg : all) {
                if (!"SEG".equals(seg.modality())) {
                    continue;
                }
                resolveSeg(studyUid, seg.seriesUid(), sources, out);
            }
        }
        return out;
    }

    /** シリーズの Modality。見つからなければ null。 */
    public String modalityOf(String studyUid, String seriesUid) {
        return series.list(studyUid).stream().filter(s -> s.seriesUid().equals(seriesUid))
                .map(SeriesInfo::modality).findFirst().orElse(null);
    }

    private void resolveSeg(String studyUid, String segUid, List<SeriesInfo> sources, List<BatchPair> out) {
        List<SegmentInfo> segs;
        SegHeader header;
        try {
            segs = segments.read(studyUid, segUid);
            header = headers.read(studyUid, segUid);
        } catch (IOException | IllegalArgumentException e) {
            out.add(BatchPair.excluded(studyUid, segUid, null, null,
                    "SEG を読めません: " + e.getClass().getSimpleName() + ": " + e.getMessage()));
            return;
        }
        if (segs.isEmpty() || header == null) {
            out.add(BatchPair.excluded(studyUid, segUid, null, null,
                    "前景のあるセグメントがありません（マスクが空）"));
            return;
        }

        List<String> sourceUids = sources.stream().map(SeriesInfo::seriesUid).toList();
        List<String> referenced = header.referencedSeriesUids().stream().filter(sourceUids::contains).toList();
        String source = null;
        List<String> candidates = referenced;
        String reason = null;
        if (referenced.size() == 1) {
            source = referenced.get(0);
        } else {
            reason = referenced.isEmpty()
                    ? "SEG が参照する元画像シリーズをこのスタディに見つけられません"
                    : "SEG が複数の元画像シリーズを参照しています";
            if (referenced.isEmpty() && header.frameOfReferenceUid() != null) {
                List<String> byFrame = new ArrayList<>();
                for (SeriesInfo s : sources) {
                    if (header.frameOfReferenceUid().equals(frames.of(studyUid, s.seriesUid()))) {
                        byFrame.add(s.seriesUid());
                    }
                }
                candidates = byFrame;
            }
        }

        for (int rank = 0; rank < segs.size(); rank++) {
            SegmentInfo sg = segs.get(rank);
            if (source != null) {
                out.add(new BatchPair(studyUid, source, segUid, sg.number(), sg.label(), rank,
                        BatchPair.Status.AUTO, null, List.of(source)));
            } else if (candidates.isEmpty()) {
                out.add(new BatchPair(studyUid, null, segUid, sg.number(), sg.label(), rank,
                        BatchPair.Status.EXCLUDED, reason + "（同じ FrameOfReference の候補もありません）", List.of()));
            } else {
                out.add(new BatchPair(studyUid, null, segUid, sg.number(), sg.label(), rank,
                        BatchPair.Status.NEEDS_CONFIRMATION, reason, candidates));
            }
        }
    }
}
