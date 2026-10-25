/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import com.vis.graphynext.dbadmin.DbAdminService;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.gdrive.StorageChanged;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 自動削除の実行。<b>取り消せないデータの削除</b>なので、歯止めを重ねる:
 * <ul>
 *   <li>有効にしていなければ（{@link RetentionService#isEnabled}）何もしない。</li>
 *   <li>モード A（Drive が正本）では何もしない（Drive の正本までゴミ箱に送ってしまうため）。</li>
 *   <li>有効にした直後の 1 回目は、利用者が試算で見た検査だけを消す。</li>
 *   <li>1 件ずつ、消す直前にもう一度、ロック・開いている・判定開始後の受信を確かめる。</li>
 *   <li>ファイルを消せなかった画像は索引に残す（{@link DbAdminService#deleteStudyForRetention}）。</li>
 * </ul>
 * 入口は ①受信・取り込み（{@link StorageChanged}）②日付の変わり目と起動時 ③手動の「今すぐ実行」。同時に 1 つだけ走り、
 * 走行中に来た要求は「終わったらもう 1 回」に畳まれる。自分の削除が起こしたイベントでは走らない。
 */
@Component
public class RetentionRunner {

    private static final Logger log = LoggerFactory.getLogger(RetentionRunner.class);

    /** 自分（このスレッド）の削除が出したイベントを見分ける印。 */
    private static final ThreadLocal<Boolean> IN_RUN = new ThreadLocal<>();

    /** 日付が変わったかを見る間隔。判定の意味を決める値ではなく、日付の変更に気付くのが最大この分だけ遅れるだけ。 */
    private static final long DAY_CHANGE_TICK_MINUTES = 15;

    private final RetentionService service;
    private final DbAdminService dbAdmin;
    private final StudyRetentionHoldRepository holds;
    private final InUseRegistry inUse;
    private final DicomInstanceRepository repo;
    private final FreeSpaceProvider freeSpace;
    private final StorageLayout layout;
    private final RetentionEventRepository events;
    private final RetentionRunRepository runs;
    private final Clock clock;
    private final boolean autoRun;

    private final ReentrantLock lock = new ReentrantLock();
    private final AtomicBoolean queued = new AtomicBoolean();
    private volatile Executor executor;
    private ScheduledExecutorService scheduler;
    private volatile LocalDate lastDay;
    /** テスト用: 1 件ずつ、再確認の直前に呼ぶ（計画のあとに状態が変わる競合を作る）。 */
    private java.util.function.Consumer<String> beforeEach;

    void setBeforeEach(java.util.function.Consumer<String> hook) {
        this.beforeEach = hook;
    }

    @Autowired
    public RetentionRunner(RetentionService service, DbAdminService dbAdmin, StudyRetentionHoldRepository holds,
                           InUseRegistry inUse, DicomInstanceRepository repo, FreeSpaceProvider freeSpace,
                           StorageLayout layout, RetentionEventRepository events, RetentionRunRepository runs,
                           @Value("${graphy.retention.auto-run:true}") boolean autoRun) {
        this(service, dbAdmin, holds, inUse, repo, freeSpace, layout, events, runs, Clock.systemUTC(), autoRun, null);
    }

    /** テスト用: 時計と実行場所（同じスレッドで直接走らせる等）を差し替える。 */
    RetentionRunner(RetentionService service, DbAdminService dbAdmin, StudyRetentionHoldRepository holds,
                    InUseRegistry inUse, DicomInstanceRepository repo, FreeSpaceProvider freeSpace, StorageLayout layout,
                    RetentionEventRepository events, RetentionRunRepository runs, Clock clock, boolean autoRun,
                    Executor executor) {
        this.service = service;
        this.dbAdmin = dbAdmin;
        this.holds = holds;
        this.inUse = inUse;
        this.repo = repo;
        this.freeSpace = freeSpace;
        this.layout = layout;
        this.events = events;
        this.runs = runs;
        this.clock = clock;
        this.autoRun = autoRun;
        this.executor = executor;
    }

    /**
     * 周期処理は起動が終わってから始める（起動中に設定のロックと取り合うため。{@code ImportWatchService} と同じ）。
     * 起動時と日付が変わるたびに 1 回判定する。
     */
    @EventListener(ApplicationReadyEvent.class)
    void start() {
        if (!autoRun || scheduler != null) {
            return;
        }
        scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "retention");
            t.setDaemon(true);
            return t;
        });
        executor = scheduler;
        scheduler.scheduleWithFixedDelay(this::tickSafe, 0, DAY_CHANGE_TICK_MINUTES, TimeUnit.MINUTES);
    }

    @PreDestroy
    void shutdown() {
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
    }

    private void tickSafe() {
        try {
            tickDay(LocalDate.now(clock.withZone(ZoneId.systemDefault())));
        } catch (RuntimeException e) {
            log.warn("自動削除の日次判定に失敗しました（続行）", e);
        }
    }

    /** 日付が前回と違えば判定を 1 回要求する（初回も要求する）。 */
    void tickDay(LocalDate today) {
        if (!today.equals(lastDay)) {
            lastDay = today;
            request("daily");
        }
    }

    /** 受信・取り込み（と、削除の通知）。自分の削除が出したものは無視する。 */
    @EventListener
    public void onStorageChanged(StorageChanged e) {
        if (Boolean.TRUE.equals(IN_RUN.get()) || executor == null) {
            return;
        }
        request("storage");
    }

    /** 判定を要求する。走行中・待機中の要求は 1 つに畳まれる。 */
    private void request(String trigger) {
        Executor ex = executor;
        if (ex == null) {
            return;
        }
        if (queued.compareAndSet(false, true)) {
            ex.execute(() -> {
                queued.set(false);
                runGuarded(trigger);
            });
        }
    }

    /** 実行場所のスレッドで走らせる。例外は握りつぶさず、ログに出して次の入口に任せる。 */
    void runGuarded(String trigger) {
        lock.lock();
        try {
            doRun(trigger, false);
        } catch (RuntimeException e) {
            log.warn("自動削除の判定に失敗しました（次の機会に再試行します）", e);
        } finally {
            lock.unlock();
        }
    }

    /** 手動の「今すぐ実行」。走行中なら IllegalStateException("running")、有効でなければ ("not-enabled")。 */
    public RetentionRun runNow() {
        if (!lock.tryLock()) {
            throw new IllegalStateException("running");
        }
        try {
            return doRun("manual", true);
        } finally {
            lock.unlock();
        }
    }

    private RetentionRun doRun(String trigger, boolean manual) {
        IN_RUN.set(true);
        try {
            if (!service.isEnabled()) {
                if (manual) {
                    throw new IllegalStateException("not-enabled");
                }
                return null;
            }
            if (layout.cacheMode()) {
                return recordSkip(trigger, "cache-mode-unsupported", manual);
            }
            RetentionConfig cfg;
            try {
                cfg = service.config();
            } catch (IllegalArgumentException e) {
                return recordSkip(trigger, "config-invalid", manual);
            }
            if (!manual && "storage".equals(trigger) && !needed(cfg)) {
                return null; // 受信のたびに計画を立てない（空きも合計も条件内）
            }
            long now = clock.millis();
            long planStart = now;
            RetentionPlan plan = service.plan(now, planStart);
            Set<String> first = service.firstRunStudies();
            List<RetentionPlan.Item> items = first.isEmpty() ? plan.items()
                    : plan.items().stream().filter(i -> first.contains(i.studyUid())).toList();
            if (items.isEmpty() && plan.satisfied() && !manual) {
                if (!first.isEmpty()) {
                    service.resolveFirstRun(plan.protectedUids()); // 保護中の対象は、見せた検査として残す
                }
                return null; // 何も消さず、警告も無い実行は記録しない
            }
            return execute(trigger, plan, items, !first.isEmpty(), planStart);
        } finally {
            IN_RUN.remove();
        }
    }

    /** 保管庫の上限か空きの下限を割っているか（受信のたびの軽い門）。 */
    private boolean needed(RetentionConfig cfg) {
        Long max = cfg.maxBytes();
        Long minFree = cfg.minFreeBytes();
        if (max == null && minFree == null) {
            return false; // 日数だけの条件は、日付の変わり目に判定する
        }
        return (max != null && repo.totalSizeBytes() > max) || (minFree != null && freeSpace.usableBytes() < minFree);
    }

    private RetentionRun execute(String trigger, RetentionPlan plan, List<RetentionPlan.Item> items, boolean firstRun,
                                 long planStart) {
        String runId = UUID.randomUUID().toString();
        int deleted = 0;
        int partial = 0;
        int failed = 0;
        int skipped = 0;
        long freed = 0;
        boolean aborted = false;
        for (RetentionPlan.Item item : items) {
            if (beforeEach != null) {
                beforeEach.accept(item.studyUid());
            }
            String why = recheck(item.studyUid(), planStart);
            if (why != null) {
                skipped++;
                record(runId, item, "skipped", 0, why);
                continue;
            }
            try {
                DbAdminService.RetentionDeleteResult res = dbAdmin.deleteStudyForRetention(item.studyUid());
                freed += res.bytesFreed();
                if (res.rows() == 0) {
                    skipped++;
                    record(runId, item, "skipped", 0, "gone");
                } else if (res.failed() == 0) {
                    deleted++;
                    record(runId, item, "deleted", 0, null);
                } else if (res.removed() > 0) {
                    partial++;
                    record(runId, item, "partial", res.failed(), "fileDelete");
                } else {
                    failed++;
                    record(runId, item, "failed", res.failed(), "fileDelete");
                }
            } catch (RuntimeException e) {
                failed++;
                aborted = true;
                record(runId, item, "failed", 0, e.getClass().getSimpleName());
                log.warn("自動削除: 予期しない失敗で判定を止めます: study={} ({})", item.studyUid(), e.toString());
                break;
            }
        }
        List<String> warnings = new ArrayList<>(plan.warnings());
        if (aborted) {
            warnings.add("aborted");
        }
        boolean satisfied = plan.satisfied() && partial + failed == 0 && !aborted;
        if (firstRun) {
            // 削除を試みた検査は（失敗があっても）これで終わり。保護で外れた対象だけ残し、見せていない検査は消さない
            service.resolveFirstRun(plan.protectedUids());
        }
        RetentionRun run = runs.save(new RetentionRun(runId, Instant.now(clock), trigger, items.size(), deleted, partial,
                failed, skipped, freed, satisfied, String.join(",", warnings)));
        // 🔴 ログには患者名を出さない（件数・容量・理由だけ）
        log.info("自動削除({}): 計画 {} 件・削除 {}・一部失敗 {}・失敗 {}・直前に除外 {}・解放 {} バイト・条件{}・保護で除外 {}",
                trigger, items.size(), deleted, partial, failed, skipped, freed, satisfied ? "を満たした" : "は未達",
                plan.protectedSkips());
        return run;
    }

    /** 消す直前の再確認（安いもの）。除外する理由、無ければ null。 */
    String recheck(String studyUid, long planStart) {
        if (holds.existsById(studyUid)) {
            return "lock";
        }
        if (inUse.snapshot().contains(studyUid)) {
            return "inUse";
        }
        List<DicomInstanceRepository.StudyRetentionRow> rows = repo.studyRetentionRowOf(studyUid);
        if (rows.isEmpty()) {
            return "gone";
        }
        DicomInstanceRepository.StudyRetentionRow r = rows.get(0);
        if (r.getLastReceivedAt() == null || r.getUnknownReceived() > 0) {
            return "unknownReceived";
        }
        if (r.getLastReceivedAt() >= planStart) {
            return "receivedAfterPlanStart";
        }
        return null;
    }

    private void record(String runId, RetentionPlan.Item item, String result, int failedFiles, String errorKind) {
        events.save(new RetentionEvent(UUID.randomUUID().toString(), runId, Instant.now(clock), item.studyUid(),
                item.patientId(), item.patientName(), item.studyDate(), item.modality(), item.instances(),
                item.sizeBytes(), item.reason(), result, failedFiles, errorKind));
    }

    /** 実行できない理由を実行の記録に 1 回だけ残す（受信のたびに同じ行を増やさない。手動のときは必ず返す）。 */
    private RetentionRun recordSkip(String trigger, String warning, boolean manual) {
        List<RetentionRun> latest = runs.findAllByOrderByAtDesc(PageRequest.of(0, 1));
        if (!manual && !latest.isEmpty() && warning.equals(latest.get(0).getWarnings())) {
            return null;
        }
        return runs.save(new RetentionRun(UUID.randomUUID().toString(), Instant.now(clock), trigger, 0, 0, 0, 0, 0, 0,
                false, warning));
    }
}
