/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dbtransfer.RelatedData;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.radiomics.GlamAnalysisDocument;
import com.vis.graphynext.radiomics.GlamAnalysisDocumentRepository;
import com.vis.graphynext.report.KeyImageRef;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.settings.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * シリーズの統合・分割（SeriesInstanceUID の書き換え）のあと、シリーズを指す記録を新しいシリーズへ追従させる。
 * 塗り ROI は {@link com.vis.graphynext.roi.RoiMaskSeriesRelocator}。ここは次の 3 つ。
 * <ul>
 *   <li>レポートのキー画像: SOP は不変なので、移した SOP のキー画像のシリーズを新しいシリーズへ。</li>
 *   <li>GLAM 解析: 元のシリーズのインスタンスが全部出て行き先が 1 つのときだけ付け替える（分割は全体への解析で
 *       どの部分か決まらないので動かさない）。</li>
 *   <li>XA 校正（設定 {@code xa.calibration.<seriesUid>}）: 行き先に校正が無ければ値をコピーする。違う値が既に
 *       あれば上書きせず衝突として数える。元のシリーズが全部出て衝突が無ければ元のキーを消す。</li>
 * </ul>
 * 一意に決まらないものは選ばず、残して件数に出す。
 */
@Component
public class SeriesRefsRelocator {

    private static final Logger log = LoggerFactory.getLogger(SeriesRefsRelocator.class);

    public record Result(int keyImages, int glam, int glamSkipped, int calibrations, int calibrationConflicts) {
        static final Result NONE = new Result(0, 0, 0, 0, 0);

        Result plus(Result o) {
            return new Result(keyImages + o.keyImages, glam + o.glam, glamSkipped + o.glamSkipped,
                    calibrations + o.calibrations, calibrationConflicts + o.calibrationConflicts);
        }
    }

    private final ReportRepository reports;
    private final GlamAnalysisDocumentRepository glam;
    private final SettingsService settings;
    private final DicomInstanceRepository instances;

    public SeriesRefsRelocator(ReportRepository reports, GlamAnalysisDocumentRepository glam, SettingsService settings,
                               DicomInstanceRepository instances) {
        this.reports = reports;
        this.glam = glam;
        this.settings = settings;
        this.instances = instances;
    }

    /**
     * @param oldSeriesBySop 別シリーズへ移った SOP → 移す前のシリーズ
     * @param newSeriesBySop 同 → 移した後のシリーズ
     */
    public Result relocate(String studyUid, Map<String, String> oldSeriesBySop, Map<String, String> newSeriesBySop) {
        Map<String, Map<String, String>> movesByOld = new LinkedHashMap<>();
        Map<String, String> moved = new LinkedHashMap<>(); // 実際に別シリーズへ出た SOP → 新しいシリーズ
        for (var e : oldSeriesBySop.entrySet()) {
            String now = newSeriesBySop.get(e.getKey());
            if (now != null && !now.equals(e.getValue())) {
                movesByOld.computeIfAbsent(e.getValue(), k -> new LinkedHashMap<>()).put(e.getKey(), now);
                moved.put(e.getKey(), now);
            }
        }
        if (moved.isEmpty()) {
            return Result.NONE;
        }
        Result total = new Result(relinkKeyImages(studyUid, moved), 0, 0, 0, 0);
        List<GlamAnalysisDocument> docs = glam.findByStudyInstanceUidOrderBySavedAtDesc(studyUid);
        Map<String, String> cal = settings.getAll();
        for (var e : movesByOld.entrySet()) {
            String old = e.getKey();
            Set<String> targets = new LinkedHashSet<>(e.getValue().values());
            boolean allLeft = instances.findBySeries(studyUid, old).isEmpty();
            total = total.plus(relinkGlam(docs, old, allLeft && targets.size() == 1 ? targets.iterator().next() : null));
            total = total.plus(followCalibration(cal, old, targets, allLeft));
        }
        if (total != Result.NONE && (total.keyImages + total.glam + total.glamSkipped + total.calibrations
                + total.calibrationConflicts) > 0) {
            log.info("シリーズを指す記録を追従させました: study={} {}", studyUid, total);
        }
        return total;
    }

    private int relinkKeyImages(String studyUid, Map<String, String> moved) {
        int n = 0;
        for (Report r : reports.findByStudyInstanceUidOrderByCreatedAtDesc(studyUid)) {
            for (KeyImageRef k : r.getKeyImages()) {
                String now = moved.get(k.getSopInstanceUid());
                if (now != null && !now.equals(k.getSeriesInstanceUid())) {
                    k.setSeriesInstanceUid(now);
                    n++;
                }
            }
        }
        return n;
    }

    /** target が null のときは付け替えず、元のシリーズを指す文書を skipped に数える。 */
    private Result relinkGlam(List<GlamAnalysisDocument> docs, String old, String target) {
        int done = 0;
        int skipped = 0;
        for (GlamAnalysisDocument d : docs) {
            boolean src = old.equals(d.getSourceSeriesUid());
            boolean mask = old.equals(d.getMaskSeriesUid());
            if (!src && !mask) {
                continue;
            }
            if (target == null) {
                skipped++;
            } else {
                d.relinkSeries(src ? target : null, mask ? target : null);
                glam.save(d);
                done++;
            }
        }
        return new Result(0, done, skipped, 0, 0);
    }

    private Result followCalibration(Map<String, String> cal, String old, Set<String> targets, boolean allLeft) {
        String value = cal.get(RelatedData.calibrationKey(old));
        if (value == null) {
            return Result.NONE;
        }
        Map<String, String> put = new LinkedHashMap<>();
        int copied = 0;
        int conflicts = 0;
        for (String t : targets) {
            String key = RelatedData.calibrationKey(t);
            String cur = cal.get(key);
            if (cur == null) {
                put.put(key, value);
                cal.put(key, value);
                copied++;
            } else if (!Objects.equals(cur, value)) {
                conflicts++; // 違う値が既にある。どちらを採るかは決めず、上書きしない
            }
        }
        if (!put.isEmpty()) {
            settings.putAll(put);
        }
        if (allLeft && conflicts == 0) {
            settings.deleteKeys(List.<String>of(RelatedData.calibrationKey(old)));
            cal.remove(RelatedData.calibrationKey(old));
        }
        return new Result(0, 0, 0, copied, conflicts);
    }
}
