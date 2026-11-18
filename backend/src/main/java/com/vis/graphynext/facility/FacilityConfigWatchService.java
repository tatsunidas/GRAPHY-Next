/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.facility;

import com.vis.graphynext.settings.SettingsService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.InvalidPathException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * 施設の資料パネルの設定ファイル（JSON 1 つ）を監視して、検証を通した内容を保持する。
 *
 * <p>1 秒ごとにファイルを見る。<b>書きかけを読まない</b>ため、大きさと更新時刻が 2 回続けて同じになってから読む
 * （{@code EmrWatchService} と同じ流儀）。検証に失敗したら<b>直前の有効な内容を保ち</b>、理由のコードだけを出す。
 * 再起動なしで反映する。
 *
 * <p>🔴 <b>読むファイルのパスの決め方</b>: ① サーバー側のプロパティ {@code graphy.facility.config-path}
 * （環境変数 {@code GRAPHY_FACILITY_CONFIG_PATH}。管理者が決める）があればそれ。② なければ、<b>standalone のときだけ</b>
 * 設定 {@code facility.configPath}（利用者の端末の中の話）。<b>Web のサーバーでは設定のパスを使わない</b>
 * （設定を書き換えられる利用者が、任意のサーバー上のパスを読ませられるため。電子カルテ連携が standalone だけなのと同じ理由）。
 */
@Service
public class FacilityConfigWatchService {

    private static final Logger log = LoggerFactory.getLogger(FacilityConfigWatchService.class);
    static final long TICK_MS = 1000;
    public static final String KEY_PATH = "facility.configPath";

    /** 状態。{@code state}: unconfigured / missing / ok / error。{@code source}: server / setting / none。 */
    public record State(String state, String error, String errorPath, Long lastReadAt, int rev, String source) {
    }

    private final Supplier<Map<String, String>> settings;
    private final Clock clock;
    private final String serverPath;
    private final boolean standalone;
    private final boolean autoRun;
    private ScheduledExecutorService executor;

    // tick() のスレッドだけが書く。他のスレッドは volatile を読む。
    private String lastPath;
    private String prevKey;
    private String parsedKey;
    private int rev;
    private volatile FacilityConfig config;
    private volatile State state = new State("unconfigured", null, null, null, 0, "none");

    @Autowired
    public FacilityConfigWatchService(SettingsService settings, Environment env,
                                      @Value("${graphy.facility.config-path:}") String serverPath,
                                      @Value("${graphy.facility.auto-run:true}") boolean autoRun) {
        this(settings::getAll, Clock.systemUTC(), serverPath, env.acceptsProfiles(Profiles.of("standalone")), autoRun);
    }

    FacilityConfigWatchService(Supplier<Map<String, String>> settings, Clock clock, String serverPath,
                               boolean standalone, boolean autoRun) {
        this.settings = settings;
        this.clock = clock;
        this.serverPath = serverPath == null ? "" : serverPath.trim();
        this.standalone = standalone;
        this.autoRun = autoRun;
    }

    /** 周期処理は起動が終わってから始める（コンストラクタで始めると設定のロックと逆順に取り合うことがある）。 */
    @EventListener(ApplicationReadyEvent.class)
    void start() {
        if (!autoRun || executor != null) {
            return;
        }
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "facility-config-watch");
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

    public State state() {
        return state;
    }

    /** 有効な最新の内容。未設定・まだ読めていないときは null。 */
    public FacilityConfig config() {
        return config;
    }

    private void tickSafe() {
        try {
            tick();
        } catch (RuntimeException e) {
            log.warn("施設の資料パネルの監視に失敗しました（続行）: {}", e.getClass().getSimpleName());
        }
    }

    /** 設定または環境から、読むパスと出どころを決める。 */
    String[] resolvePath() {
        if (!serverPath.isEmpty()) {
            return new String[] {serverPath, "server"};
        }
        if (standalone) {
            String p = settings.get().get(KEY_PATH);
            if (p != null && !p.isBlank()) {
                return new String[] {p.trim(), "setting"};
            }
        }
        return new String[] {null, "none"};
    }

    /** 1 回見る。テストから直接呼ぶ。 */
    synchronized void tick() {
        String[] src = resolvePath();
        String path = src[0];
        String source = src[1];
        if (path == null) {
            reset();
            publish("unconfigured", null, null, null, source);
            return;
        }
        if (!path.equals(lastPath)) { // パスが変わったら、前のファイルの内容は捨てて読み直す
            lastPath = path;
            prevKey = null;
            parsedKey = null;
            if (config != null) {
                config = null;
                rev++;
            }
        }
        Path target;
        try {
            target = Path.of(path);
        } catch (InvalidPathException e) {
            publish("error", "path-unreadable", null, state.lastReadAt(), source);
            return;
        }
        if (!Files.exists(target)) {
            prevKey = null;
            parsedKey = null;
            publish("missing", "file-missing", null, state.lastReadAt(), source);
            return;
        }
        String key;
        try {
            key = FacilityConfigReader.signature(target);
        } catch (IOException e) {
            publish("error", "read-failed", null, state.lastReadAt(), source);
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
        long now = clock.millis();
        FacilityConfigReader.Result r = FacilityConfigReader.read(target);
        if (!r.ok()) {
            publish("error", r.error(), null, now, source);
            return;
        }
        FacilityConfigParser.Result p = FacilityConfigParser.parse(r.text());
        if (!p.ok()) {
            publish("error", p.error(), p.errorPath(), now, source); // 直前の有効な内容は保つ
            return;
        }
        if (!p.config().equals(config)) {
            config = p.config();
            rev++;
        }
        publish("ok", null, null, now, source);
    }

    private void reset() {
        lastPath = null;
        prevKey = null;
        parsedKey = null;
        if (config != null) {
            config = null;
            rev++;
        }
    }

    private void publish(String st, String error, String errorPath, Long lastReadAt, String source) {
        State s = new State(st, error, errorPath, lastReadAt, rev, source);
        // 内容の更新・状態の変化のときだけ rev を進めたいが、状態だけが変わる場合（ok→error）も画面は変わるので、
        // 状態の違いは ETag 側（State 全体から作る）で検出する。
        state = s;
    }
}
