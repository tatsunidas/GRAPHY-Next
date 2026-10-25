/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.settings.SettingsService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 自動削除の判定（段 1: 条件の保存・試算・ロック・参考値）。<b>このクラスは何も消さない。</b>
 * 削除の実行は別の段で足す（そのときも計画は {@link RetentionPlanner} を共有する）。
 */
@Service
public class RetentionService {

    private final DicomInstanceRepository repo;
    private final StudyRetentionHoldRepository holds;
    private final RetentionProtections protections;
    private final FreeSpaceProvider freeSpace;
    private final SettingsService settings;
    private final Clock clock;

    @Autowired
    public RetentionService(DicomInstanceRepository repo, StudyRetentionHoldRepository holds,
                            RetentionProtections protections, FreeSpaceProvider freeSpace, SettingsService settings) {
        this(repo, holds, protections, freeSpace, settings, Clock.systemUTC());
    }

    RetentionService(DicomInstanceRepository repo, StudyRetentionHoldRepository holds, RetentionProtections protections,
                     FreeSpaceProvider freeSpace, SettingsService settings, Clock clock) {
        this.repo = repo;
        this.holds = holds;
        this.protections = protections;
        this.freeSpace = freeSpace;
        this.settings = settings;
        this.clock = clock;
    }

    public RetentionConfig config() {
        return RetentionConfig.from(settings.getAll());
    }

    /** 条件を保存する（空の条件は消す）。不正な値は IllegalArgumentException で、何も保存しない。 */
    public RetentionConfig saveConfig(RetentionConfig cfg) {
        cfg.validated();
        Map<String, String> m = cfg.toSettings();
        Map<String, String> put = new java.util.LinkedHashMap<>();
        List<String> drop = new ArrayList<>();
        m.forEach((k, v) -> {
            if (v == null) {
                drop.add(k);
            } else {
                put.put(k, v);
            }
        });
        if (!put.isEmpty()) {
            settings.putAll(put);
        }
        if (!drop.isEmpty()) {
            settings.deleteKeys(drop);
        }
        return config();
    }

    /** 試算。今の条件で消える検査の計画を返すだけ（1 ファイルも消さない）。 */
    @Transactional(readOnly = true)
    public RetentionPlan preview() {
        long now = clock.millis();
        List<StudyStat> studies = stats();
        long store = studies.stream().mapToLong(StudyStat::sizeBytes).sum();
        return RetentionPlanner.plan(studies, protections.collect(studies), config(), freeSpace.usableBytes(), store, now, now);
    }

    /** 検査ごとの集計。 */
    @Transactional(readOnly = true)
    public List<StudyStat> stats() {
        List<StudyStat> out = new ArrayList<>();
        for (DicomInstanceRepository.StudyRetentionRow r : repo.studyRetentionRows()) {
            String key = r.getPatientId() != null && !r.getPatientId().isEmpty() ? r.getPatientId()
                    : r.getPatientName() != null && !r.getPatientName().isEmpty() ? r.getPatientName()
                    : r.getStudyInstanceUid();
            out.add(new StudyStat(r.getStudyInstanceUid(), key, r.getPatientId(), r.getPatientName(), r.getStudyDate(),
                    r.getModality(), r.getInstanceCount(), r.getSizeBytes() == null ? 0 : r.getSizeBytes(),
                    r.getLastReceivedAt(), r.getUnknownReceived()));
        }
        return out;
    }

    /** 画面に出す参考値（実測）。値の目安であり、しきい値の既定ではない。 */
    public record Status(long diskTotalBytes, long diskFreeBytes, long storeBytes, long studies, long largestStudyBytes,
                         Long maxDailyIntakeBytes, long recordedDays, long lockedStudies) {
    }

    @Transactional(readOnly = true)
    public Status status() {
        List<StudyStat> studies = stats();
        long store = studies.stream().mapToLong(StudyStat::sizeBytes).sum();
        long largest = studies.stream().mapToLong(StudyStat::sizeBytes).max().orElse(0);
        Long maxDay = null;
        long minD = Long.MAX_VALUE;
        long maxD = Long.MIN_VALUE;
        for (DicomInstanceRepository.DailyIntake d : repo.dailyIntake()) {
            if (d.getDay() == null || d.getBytes() == null) {
                continue;
            }
            maxDay = maxDay == null ? d.getBytes() : Math.max(maxDay, d.getBytes());
            minD = Math.min(minD, d.getDay());
            maxD = Math.max(maxD, d.getDay());
        }
        long days = maxDay == null ? 0 : maxD - minD + 1;
        return new Status(freeSpace.totalBytes(), freeSpace.usableBytes(), store, studies.size(), largest, maxDay, days,
                holds.count());
    }

    public record Hold(String studyUid, String lockedAt, boolean studyExists) {
    }

    @Transactional(readOnly = true)
    public List<Hold> listHolds() {
        List<Hold> out = new ArrayList<>();
        for (StudyRetentionHold h : holds.findAll()) {
            out.add(new Hold(h.getStudyInstanceUid(), String.valueOf(h.getLockedAt()),
                    repo.countByStudyInstanceUid(h.getStudyInstanceUid()) > 0));
        }
        return out;
    }

    /** ロックする。存在しない検査は拒否（IllegalArgumentException）。同じ検査を重ねてもよい。 */
    @Transactional
    public Hold lock(String studyUid) {
        if (studyUid == null || studyUid.isBlank() || repo.countByStudyInstanceUid(studyUid) == 0) {
            throw new IllegalArgumentException("その検査は保管庫にありません");
        }
        StudyRetentionHold h = holds.findById(studyUid).orElseGet(() ->
                holds.save(new StudyRetentionHold(studyUid, Instant.now(clock))));
        return new Hold(h.getStudyInstanceUid(), String.valueOf(h.getLockedAt()), true);
    }

    @Transactional
    public void unlock(String studyUid) {
        holds.deleteById(studyUid);
    }

    /** 保護の理由を検査ごとに返す（画面の参考・テスト用）。 */
    @Transactional(readOnly = true)
    public Map<String, Set<ProtectionReason>> protectionsOf() {
        return protections.collect(stats());
    }
}
