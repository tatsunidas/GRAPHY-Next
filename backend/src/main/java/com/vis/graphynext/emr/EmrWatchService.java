/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import com.vis.graphynext.settings.SettingsService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * 電子カルテが書き出すファイル（CSV か bat）を監視して、「いま開いている患者の ID」の変化を知らせる。
 *
 * <p>1 秒ごとに、設定（{@link EmrConfig}）に従ってファイルを見る。<b>書きかけを読まない</b>ため、大きさと更新時刻が
 * 2 回続けて同じになってから読む（{@code ImportWatchService} と同じ流儀）。読んだ ID が前回と違えば通し番号 {@code seq}
 * を進めて {@link EmrPatientChanged} を発行する。同じ ID の書き直しでは何もしない。
 *
 * <p>🔴 <b>起動直後・有効にした直後の最初の読み取りは、基準として覚えるだけで通知しない</b>
 * （前の日の ID で、起動しただけで患者が開くのを避ける）。そのときの患者は［開く］で開ける。
 *
 * <p>standalone だけ（web では、設定を書き換えられる利用者が任意のサーバー上のパスを読ませられるため）。
 */
@Service
@Profile("standalone")
public class EmrWatchService {

    private static final Logger log = LoggerFactory.getLogger(EmrWatchService.class);
    static final long TICK_MS = 1000;

    /** ファイルの状態。 */
    public record FileState(String state, String error, Long lastReadAt) {
    }

    /** いまの患者。ID を含むのでログに出さない。 */
    public record CurrentPatient(String id, long seq, long changedAt) {
    }

    private final Supplier<Map<String, String>> settings;
    private final ApplicationEventPublisher events;
    private final Clock clock;
    private final boolean autoRun;
    private ScheduledExecutorService executor;

    // tick() のスレッドだけが書く。他のスレッドは volatile を読む。
    private String prevKey;
    private String parsedKey;
    private boolean baselined;
    private String lastSettingsSig;
    private volatile FileState file = new FileState("disabled", null, null);
    private volatile CurrentPatient patient;
    private long seq;

    @Autowired
    public EmrWatchService(SettingsService settings, ApplicationEventPublisher events,
                           @Value("${graphy.emr.auto-run:true}") boolean autoRun) {
        this(settings::getAll, events, Clock.systemUTC(), autoRun);
    }

    EmrWatchService(Supplier<Map<String, String>> settings, ApplicationEventPublisher events, Clock clock,
                    boolean autoRun) {
        this.settings = settings;
        this.events = events;
        this.clock = clock;
        this.autoRun = autoRun;
    }

    /** 周期処理は起動が終わってから始める（コンストラクタで始めると設定のロックと逆順に取り合うことがある）。 */
    @EventListener(ApplicationReadyEvent.class)
    void start() {
        if (!autoRun || executor != null) {
            return;
        }
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "emr-watch");
            t.setDaemon(true);
            return t;
        });
        executor.scheduleWithFixedDelay(this::tickSafe, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS);
    }

    @PreDestroy
    void shutdown() {
        if (executor != null) {
            executor.shutdownNow();
        }
    }

    public EmrConfig config() {
        return EmrConfig.from(settings.get());
    }

    public FileState file() {
        return file;
    }

    public CurrentPatient patient() {
        return patient;
    }

    private void tickSafe() {
        try {
            tick();
        } catch (RuntimeException e) {
            log.warn("電子カルテ連携の監視に失敗しました（続行）: {}", e.getClass().getSimpleName());
        }
    }

    /** 1 回見る。テストから直接呼ぶ。 */
    synchronized void tick() {
        EmrConfig cfg = config();
        if (!cfg.enabled() || !cfg.valid()) {
            prevKey = null;
            parsedKey = null;
            baselined = false; // 無効→有効に戻したときも、最初の読み取りは基準にする
            file = new FileState(cfg.enabled() ? "invalid" : "disabled", cfg.enabled() ? cfg.errors().get(0) : null, null);
            return;
        }
        // 読み方の設定を変えたら、同じファイルを読み直す。このとき出てくる ID は基準として覚えるだけで通知しない
        // （設定を触っただけで患者が開くのを避ける）
        String cs = settingsSig(cfg);
        if (!cs.equals(lastSettingsSig)) {
            lastSettingsSig = cs;
            prevKey = null;
            parsedKey = null;
            baselined = false;
        }
        Optional<Path> target;
        try {
            target = EmrFileReader.resolve(cfg.path());
        } catch (IOException | RuntimeException e) {
            prevKey = null;
            file = new FileState("error", "path-unreadable", file.lastReadAt());
            return;
        }
        if (target.isEmpty()) {
            prevKey = null;
            parsedKey = null;
            file = new FileState("missing", "file-missing", file.lastReadAt());
            return;
        }
        String key;
        try {
            key = target.get() + "|" + EmrFileReader.signature(target.get());
        } catch (IOException e) {
            file = new FileState("error", "read-failed", file.lastReadAt());
            return;
        }
        if (!key.equals(prevKey)) {
            prevKey = key; // 初めて見た・変わった: もう 1 回、同じなら止まったとみなす（書きかけを読まない）
            return;
        }
        if (key.equals(parsedKey)) {
            return;
        }
        parsedKey = key;
        EmrFileReader.Result r = EmrFileReader.read(cfg, target.get());
        long now = clock.millis();
        if (!r.ok()) {
            file = new FileState("error", r.error(), now);
            return;
        }
        file = new FileState("ok", null, now);
        CurrentPatient cur = patient;
        if (cur != null && cur.id().equals(r.patientId())) {
            baselined = true;
            return;
        }
        if (!baselined) {
            baselined = true;
            patient = new CurrentPatient(r.patientId(), seq, now); // 基準として覚えるだけ。通知しない
            return;
        }
        seq++;
        patient = new CurrentPatient(r.patientId(), seq, now);
        events.publishEvent(new EmrPatientChanged(r.patientId(), seq));
    }

    private static String settingsSig(EmrConfig c) {
        return String.join("|", String.valueOf(c.format()), String.valueOf(c.charset()), String.valueOf(c.csvColumn()),
                String.valueOf(c.csvHeader()), String.valueOf(c.batVar()));
    }

    /** 保存した設定で今すぐ 1 回読む（安定の待ち合わせなし。設定画面の［読めるか確認］用）。状態は変えない。 */
    public EmrFileReader.Result readNow() {
        EmrConfig cfg = config();
        if (!cfg.valid() || cfg.path() == null) {
            return new EmrFileReader.Result(null, cfg.valid() ? "path-required" : cfg.errors().get(0));
        }
        try {
            Optional<Path> t = EmrFileReader.resolve(cfg.path());
            return t.isEmpty() ? new EmrFileReader.Result(null, "file-missing") : EmrFileReader.read(cfg, t.get());
        } catch (IOException | RuntimeException e) {
            return new EmrFileReader.Result(null, "path-unreadable");
        }
    }
}
