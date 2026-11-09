/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 設定した時刻に事前取得を走らせる。1 分ごとに、今日の「過ぎた最新の枠」が COMPLETE か確かめる。
 *
 * <ul>
 *   <li>枠の鍵は {@code 日付T時刻}。同じ枠が COMPLETE なら二度走らせない。</li>
 *   <li>枠の時刻から {@link #GRACE} 以内なら常に実行する。それを過ぎていたら、{@code catchUpOnStartup} が有効なときだけ
 *       実行する（アプリを閉じていた間の取りこぼしを、起動後に取り戻す）。</li>
 *   <li>通信先の障害で INTERRUPTED／ERROR になった枠は、{@link #RETRY} ごとに再試行する（取得済みは飛ばすので重複しない）。</li>
 * </ul>
 */
@Component
@Profile("standalone")
public class PrefetchRunner {

    private static final Logger log = LoggerFactory.getLogger(PrefetchRunner.class);

    /** 枠の時刻から、取りこぼし扱いにするまでの猶予（tick の 1 分の 2 回分より長ければ足りる）。 */
    static final Duration GRACE = Duration.ofMinutes(5);
    /** 失敗した枠を再試行する間隔。障害の復旧を待つだけで、結果の意味を決める値ではない。 */
    static final Duration RETRY = Duration.ofMinutes(15);
    private static final long TICK_SECONDS = 60;

    private final PrefetchService service;
    private final PrefetchRunRepository runs;
    private final Clock clock;
    private final boolean autoRun;
    private ScheduledExecutorService scheduler;

    @Autowired
    public PrefetchRunner(PrefetchService service, PrefetchRunRepository runs,
                          @Value("${graphy.prefetch.auto-run:true}") boolean autoRun) {
        this(service, runs, Clock.systemDefaultZone(), autoRun);
    }

    /** テスト用: 時計を差し替える。 */
    PrefetchRunner(PrefetchService service, PrefetchRunRepository runs, Clock clock, boolean autoRun) {
        this.service = service;
        this.runs = runs;
        this.clock = clock;
        this.autoRun = autoRun;
    }

    /** 起動が終わってから始める（設定のロックと取り合わないため。他の定期処理と同じ）。 */
    @EventListener(ApplicationReadyEvent.class)
    void start() {
        if (!autoRun || scheduler != null) {
            return;
        }
        scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "prefetch");
            t.setDaemon(true);
            return t;
        });
        scheduler.scheduleWithFixedDelay(this::tickSafe, 0, TICK_SECONDS, TimeUnit.SECONDS);
    }

    @PreDestroy
    void shutdown() {
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
    }

    private void tickSafe() {
        try {
            tick();
        } catch (RuntimeException e) {
            log.warn("事前取得の定時判定に失敗しました（続行）", e);
        }
    }

    /** 1 回の判定。実行したら true。 */
    boolean tick() {
        PrefetchConfig cfg = service.config();
        if (!cfg.enabled() || !cfg.valid() || service.isRunning()) {
            return false;
        }
        LocalDateTime now = LocalDateTime.now(clock);
        LocalDate today = now.toLocalDate();
        LocalTime latest = null;
        for (LocalTime t : cfg.times()) {
            if (!t.isAfter(now.toLocalTime())) {
                latest = t;
            }
        }
        if (latest == null) {
            return false;
        }
        String slot = today + "T" + latest;
        if (runs.existsBySlotKeyAndStatus(slot, PrefetchRun.COMPLETE)) {
            return false;
        }
        boolean withinGrace = Duration.between(today.atTime(latest), now).compareTo(GRACE) <= 0;
        PrefetchRun last = runs.findTopBySlotKeyOrderByIdDesc(slot);
        if (last == null) {
            if (!withinGrace && !cfg.catchUp()) {
                return false;
            }
        } else {
            if (!cfg.catchUp() && !withinGrace) {
                return false;
            }
            Long finished = last.getFinishedAt();
            if (finished == null || Duration.ofMillis(clock.millis() - finished).compareTo(RETRY) < 0) {
                return false; // 走行中の記録、または再試行の間隔が来ていない
            }
        }
        try {
            service.run(PrefetchService.SCHEDULE, slot);
        } catch (IllegalStateException e) {
            return false; // 手動の実行と重なった
        }
        return true;
    }
}
