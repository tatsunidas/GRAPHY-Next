/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import org.springframework.data.domain.PageRequest;
import com.vis.graphynext.settings.SettingsService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 自動削除の判定（条件の保存・試算・有効化・ロック・参考値）。<b>このクラスは何も消さない</b>
 * （消すのは {@link RetentionRunner}。計画は {@link RetentionPlanner} を共有する）。
 *
 * <p>有効化の歯止め: 条件を保存すると自動削除はオフに戻る。有効にするには、今の条件で試算した結果（previewId）を
 * 添える。最初の 1 回は、その試算で見せた検査だけを消す。保存方式が「Drive が正本」（モード A）のときは有効にできない。
 */
@Service
public class RetentionService {

    private final DicomInstanceRepository repo;
    private final StudyRetentionHoldRepository holds;
    private final RetentionProtections protections;
    private final FreeSpaceProvider freeSpace;
    private final SettingsService settings;
    private final Clock clock;
    private final RetentionFirstRunRepository firstRun;
    private final RetentionRunRepository runs;
    private final StorageLayout layout;

    public static final String KEY_ENABLED = "retention.enabled";
    public static final String KEY_LAST_SEEN_RUN = "retention.lastSeenRun";
    /** 保持する試算の数（メモリ。古い順に捨てる）。 */
    private static final int MAX_PREVIEWS = 16;

    /** 試算の記録: 条件の指紋と、計画に入った検査。有効化のとき、条件が変わっていないことと最初の 1 回の対象を決める。 */
    private record PreviewRecord(String fingerprint, List<String> studyUids) {
    }

    private final Map<String, PreviewRecord> previews = new LinkedHashMap<>();

    @Autowired
    public RetentionService(DicomInstanceRepository repo, StudyRetentionHoldRepository holds,
                            RetentionProtections protections, FreeSpaceProvider freeSpace, SettingsService settings,
                            RetentionFirstRunRepository firstRun, RetentionRunRepository runs, StorageLayout layout) {
        this(repo, holds, protections, freeSpace, settings, firstRun, runs, layout, Clock.systemUTC());
    }

    RetentionService(DicomInstanceRepository repo, StudyRetentionHoldRepository holds, RetentionProtections protections,
                     FreeSpaceProvider freeSpace, SettingsService settings, RetentionFirstRunRepository firstRun,
                     RetentionRunRepository runs, StorageLayout layout, Clock clock) {
        this.firstRun = firstRun;
        this.runs = runs;
        this.layout = layout;
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
        // 条件を変えたら、試算を見せ直すまで自動削除はオフ（見せていない条件で消さない）
        disable();
        return config();
    }

    /**
     * 有効か。保存値は「有効にしたときの条件の指紋」で、<b>今の条件の指紋と一致したときだけ</b>有効とみなす。
     * 汎用の設定 API で {@code true} を書かれても、条件を（このクラスを通さず）書き換えても、有効にならない
     * （見せていない条件で消さない）。条件の値が壊れているときも無効。
     */
    public boolean isEnabled() {
        Map<String, String> all = settings.getAll();
        String v = all.get(KEY_ENABLED);
        if (v == null || v.isBlank() || "false".equals(v)) {
            return false;
        }
        try {
            RetentionConfig cfg = RetentionConfig.from(all);
            return cfg.any() && v.equals(fingerprint(cfg));
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** 自動削除をオフにして、最初の 1 回の対象も消す。 */
    @Transactional
    public void disable() {
        settings.putAll(Map.of(KEY_ENABLED, "false"));
        firstRun.deleteAll();
    }

    /** 条件の指紋（試算のあとに条件が変わっていないことの確認に使う）。 */
    static String fingerprint(RetentionConfig c) {
        return c.days() + "|" + c.maxGb() + "|" + c.minFreeGb();
    }

    /** 試算の結果と、有効化に添える ID。 */
    public record Preview(String previewId, RetentionPlan plan) {
    }

    /** 試算して、有効化に使える ID を付ける（ID はメモリにだけ置く）。 */
    public Preview previewWithId() {
        RetentionConfig cfg = config();
        RetentionPlan plan = preview();
        String id = UUID.randomUUID().toString();
        synchronized (previews) {
            previews.put(id, new PreviewRecord(fingerprint(cfg), plan.items().stream().map(RetentionPlan.Item::studyUid).toList()));
            while (previews.size() > MAX_PREVIEWS) {
                previews.remove(previews.keySet().iterator().next());
            }
        }
        return new Preview(id, plan);
    }

    /**
     * 有効にする。条件が 1 つ以上ある・previewId が有効・条件が試算のときのままのときだけ。保存方式が「Drive が正本」
     * （モード A）なら IllegalStateException("cache-mode-unsupported")。何も満たさなければ何も変えない。
     * 最初の 1 回の対象は、その試算に入っていた検査。
     */
    @Transactional
    public void enable(String previewId) {
        RetentionConfig cfg = config();
        if (!cfg.any()) {
            throw new IllegalArgumentException("条件が 1 つも無いので有効にできません");
        }
        if (layout.cacheMode()) {
            throw new IllegalStateException("cache-mode-unsupported");
        }
        PreviewRecord rec;
        synchronized (previews) {
            rec = previewId == null ? null : previews.get(previewId);
        }
        if (rec == null) {
            throw new IllegalArgumentException("試算が見つかりません。もう一度試算してください");
        }
        if (!rec.fingerprint().equals(fingerprint(cfg))) {
            throw new IllegalArgumentException("試算のあとに条件が変わりました。もう一度試算してください");
        }
        firstRun.deleteAll();
        firstRun.saveAll(rec.studyUids().stream().map(RetentionFirstRun::new).toList());
        settings.putAll(Map.of(KEY_ENABLED, fingerprint(cfg)));
        synchronized (previews) {
            previews.remove(previewId);
        }
    }

    /** 最初の 1 回の対象（空なら、最初の 1 回は済んでいる）。 */
    public Set<String> firstRunStudies() {
        return firstRun.findAll().stream().map(RetentionFirstRun::getStudyInstanceUid)
                .collect(java.util.stream.Collectors.toCollection(java.util.LinkedHashSet::new));
    }

    @Transactional
    public void clearFirstRun() {
        firstRun.deleteAll();
    }

    /** まだ見ていない、知らせる価値のある実行（無ければ null）。 */
    public RetentionRun notice() {
        List<RetentionRun> latest = runs.findAllByOrderByAtDesc(PageRequest.of(0, 1));
        if (latest.isEmpty()) {
            return null;
        }
        RetentionRun r = latest.get(0);
        String seen = settings.getAll().get(KEY_LAST_SEEN_RUN);
        return r.notable() && !r.getId().equals(seen) ? r : null;
    }

    /** 最新の実行を見たことにする。 */
    public void ackNotice() {
        List<RetentionRun> latest = runs.findAllByOrderByAtDesc(PageRequest.of(0, 1));
        if (!latest.isEmpty()) {
            settings.putAll(Map.of(KEY_LAST_SEEN_RUN, latest.get(0).getId()));
        }
    }

    /** 試算。今の条件で消える検査の計画を返すだけ（1 ファイルも消さない）。 */
    @Transactional(readOnly = true)
    public RetentionPlan preview() {
        long now = clock.millis();
        return plan(now, now);
    }

    /** 計画（試算と実行で共有）。planStart 以降に受信した検査は守る。 */
    @Transactional(readOnly = true)
    public RetentionPlan plan(long nowMs, long planStartMs) {
        List<StudyStat> studies = stats();
        long store = studies.stream().mapToLong(StudyStat::sizeBytes).sum();
        return RetentionPlanner.plan(studies, protections.collect(studies), config(), freeSpace.usableBytes(), store,
                nowMs, planStartMs);
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
                         Long maxDailyIntakeBytes, long recordedDays, long lockedStudies,
                         boolean enabled, boolean firstRunPending, boolean cacheMode, RetentionRun lastRun) {
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
        List<RetentionRun> last = runs.findAllByOrderByAtDesc(PageRequest.of(0, 1));
        return new Status(freeSpace.totalBytes(), freeSpace.usableBytes(), store, studies.size(), largest, maxDay, days,
                holds.count(), isEnabled(), firstRun.count() > 0, layout.cacheMode(), last.isEmpty() ? null : last.get(0));
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
