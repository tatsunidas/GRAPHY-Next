/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.settings.SettingsService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 監視フォルダの定期走査（standalone のみ）。設定したフォルダを一定間隔で走査し、<b>大きさと更新時刻が 2 回続けて
 * 同じ</b>になったファイルだけを既存の {@link ImportService#importPaths} へ渡す（書き込み途中のファイルを拾わない）。
 * 取り込みそのものは新しく書かない。したがって保管庫・索引・Google Drive への増分送信（{@code StorageChanged}）は
 * 手動の取り込みと同じ経路を通り、Drive がオフライン・未ログインでも、取り込みはローカルに対して常に成功する
 * （送信は同期が後で行う）。
 *
 * <p>処理済みは台帳（{@link ImportWatchItem}）で管理し、同じ大きさ・更新時刻なら二度と取り込まない。
 * 原本は読むだけで、移動も削除もしない。設定は走査のたびに読むので、変更は再起動なしで次の走査から効く。
 *
 * <p>Web モードでは Bean を作らない: 設定 API は利用者が書けるので、監視先を任意のパスにされると
 * サーバーのファイルを保管庫へ取り込める経路になる。
 */
@Service
@Profile("standalone")
public class ImportWatchService {

    private static final Logger log = LoggerFactory.getLogger(ImportWatchService.class);

    public static final String KEY_ENABLED = SettingsService.IMPORT_WATCH_PREFIX + "enabled";
    public static final String KEY_FOLDER = SettingsService.IMPORT_WATCH_PREFIX + "folder";
    public static final String KEY_INTERVAL = SettingsService.IMPORT_WATCH_PREFIX + "intervalSec";

    /** 画面に出す失敗の件数（表示の上限。台帳には全件残る）。 */
    static final int FAILURES_SHOWN = 20;
    /** 設定が変わったことに気付くまでの周期。走査の間隔そのものは設定の intervalSec。 */
    private static final long TICK_MS = 1_000;

    public record Failure(String path, String error) {
    }

    /**
     * @param error 設定または走査の異常（コード。{@code folder-missing}・{@code folder-not-found}・
     *     {@code folder-not-directory}・{@code folder-overlaps-db}・{@code interval-invalid}・{@code scan-failed}）。
     *     正常なら null。異常でもアプリは動き続ける。
     * @param waiting 見つけたが、大きさ・更新時刻がまだ 2 回続けて同じになっていないファイル数。
     */
    public record Status(boolean enabled, String folder, Integer intervalSec, boolean scanning, Long lastScanAt,
                         int waiting, long imported, long skipped, long failed, String error, List<Failure> failures) {
    }

    private record Config(boolean enabled, String folder, Integer intervalSec) {
    }

    private final ImportService importService;
    private final ImportWatchRepository repo;
    private final SettingsService settings;
    private final StorageLayout layout;
    private final Clock clock;
    private ScheduledExecutorService executor;

    /** 前回の走査で見た未処理ファイルの（大きさ, 更新時刻）。同じなら今回は「止まった」とみなす。 */
    private Map<String, long[]> seen = new HashMap<>();
    private volatile boolean scanning;
    private volatile Long lastScanAt;
    private volatile int waiting;
    private volatile String scanError;

    @Autowired
    public ImportWatchService(ImportService importService, ImportWatchRepository repo, SettingsService settings,
                              StorageLayout layout,
                              @Value("${graphy.import-watch.auto-run:true}") boolean autoRun) {
        this(importService, repo, settings, layout, Clock.systemUTC(), autoRun);
    }

    ImportWatchService(ImportService importService, ImportWatchRepository repo, SettingsService settings,
                       StorageLayout layout, Clock clock, boolean autoRun) {
        this.importService = importService;
        this.repo = repo;
        this.settings = settings;
        this.layout = layout;
        this.clock = clock;
        if (autoRun) {
            executor = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "import-watch");
                t.setDaemon(true);
                return t;
            });
            executor.scheduleWithFixedDelay(this::tickSafe, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS);
        }
    }

    @PreDestroy
    void shutdown() {
        if (executor != null) {
            executor.shutdownNow();
        }
    }

    private void tickSafe() {
        try {
            Config cfg = readConfig();
            if (!cfg.enabled() || cfg.intervalSec() == null || cfg.intervalSec() < 1) {
                return;
            }
            Long last = lastScanAt;
            if (last == null || clock.millis() - last >= cfg.intervalSec() * 1000L) {
                scanOnce();
            }
        } catch (RuntimeException e) {
            log.warn("監視取り込みの周期処理に失敗しました（続行）", e);
        }
    }

    private Config readConfig() {
        Map<String, String> all = settings.getAll();
        boolean enabled = Boolean.parseBoolean(all.getOrDefault(KEY_ENABLED, "false"));
        String folder = all.get(KEY_FOLDER);
        Integer interval = null;
        try {
            String v = all.get(KEY_INTERVAL);
            if (v != null && !v.isBlank()) {
                interval = Integer.valueOf(v.trim());
            }
        } catch (NumberFormatException ignore) {
            // 不正な値は interval-invalid として画面に出す
        }
        return new Config(enabled, folder == null ? null : folder.trim(), interval);
    }

    /** 設定の異常（コード）か、正常なら null。走査のたび・状態の問い合わせのたびに評価する。 */
    private String validate(Config cfg) {
        if (cfg.intervalSec() == null || cfg.intervalSec() < 1) {
            return "interval-invalid";
        }
        if (cfg.folder() == null || cfg.folder().isBlank()) {
            return "folder-missing";
        }
        Path p;
        try {
            p = Path.of(cfg.folder());
        } catch (InvalidPathException e) {
            return "folder-not-found";
        }
        if (!Files.exists(p)) {
            return "folder-not-found";
        }
        if (!Files.isDirectory(p)) {
            return "folder-not-directory";
        }
        // 保管庫を含む DB フォルダの中、または DB フォルダを含む場所を監視すると、取り込んだ物を取り込み直す輪になる
        Path store = realOrAbsolute(layout.root());
        Path parent = store.getParent();
        Path db = parent != null && parent.getNameCount() > 0 ? parent : store;
        Path real = realOrAbsolute(p);
        if (real.startsWith(db) || db.startsWith(real)) {
            return "folder-overlaps-db";
        }
        return null;
    }

    private static Path realOrAbsolute(Path p) {
        try {
            return p.toRealPath();
        } catch (IOException e) {
            return p.toAbsolutePath().normalize();
        }
    }

    public Status status() {
        Config cfg = readConfig();
        String error = null;
        if (cfg.enabled()) {
            error = validate(cfg);
            if (error == null) {
                error = scanError;
            }
        }
        List<Failure> failures = repo.findTop20ByStatusOrderByAtDesc(ImportWatchItem.FAILED).stream()
                .limit(FAILURES_SHOWN).map(i -> new Failure(i.getPath(), i.getError())).toList();
        return new Status(cfg.enabled(), cfg.folder(), cfg.intervalSec(), scanning, lastScanAt, waiting,
                repo.countByStatus(ImportWatchItem.IMPORTED), repo.countByStatus(ImportWatchItem.SKIPPED),
                repo.countByStatus(ImportWatchItem.FAILED), error, failures);
    }

    /** 1 回走査する。無効なら何もしない（最終走査の時刻も進めない）。テストと「今すぐ走査」から直接呼べる。 */
    public synchronized Status scanOnce() {
        Config cfg = readConfig();
        if (!cfg.enabled()) {
            return status();
        }
        scanning = true;
        try {
            scanError = null;
            if (validate(cfg) == null) {
                scan(Path.of(cfg.folder()).toAbsolutePath().normalize());
            }
        } catch (RuntimeException e) {
            scanError = "scan-failed";
            log.warn("監視フォルダの走査に失敗しました（続行）: {}", e.toString());
        } finally {
            lastScanAt = clock.millis();
            scanning = false;
        }
        return status();
    }

    private void scan(Path folder) {
        Map<String, ImportWatchItem> ledger = new HashMap<>();
        for (ImportWatchItem i : repo.findAll()) {
            ledger.put(i.getPath(), i);
        }
        Map<String, long[]> nextSeen = new HashMap<>();
        try {
            Files.walkFileTree(folder, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    return importService.isSkippedDir(dir) ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    if (attrs.isRegularFile()) { // リンク等は辿らない
                        visit(file, attrs.size(), attrs.lastModifiedTime().toMillis(), ledger, nextSeen);
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException e) {
                    record(file.toAbsolutePath().normalize().toString(), -1, 0, ImportWatchItem.FAILED, e.toString(),
                            ledger);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            scanError = "scan-failed";
            log.warn("監視フォルダを走査できませんでした（続行）: {}", e.toString());
        }
        seen = nextSeen;
        waiting = nextSeen.size();
    }

    private void visit(Path file, long size, long mtime, Map<String, ImportWatchItem> ledger,
                       Map<String, long[]> nextSeen) {
        String key = file.toAbsolutePath().normalize().toString();
        ImportWatchItem done = ledger.get(key);
        if (done != null && done.getSize() == size && done.getMtime() == mtime) {
            return; // 処理済み（同じ大きさ・更新時刻）
        }
        long[] prev = seen.get(key);
        if (prev == null || prev[0] != size || prev[1] != mtime) {
            nextSeen.put(key, new long[] {size, mtime}); // 初見、または書き込み中: 待機
            return;
        }
        String status;
        String error = null;
        try {
            ImportService.ImportResult r = importService.importPaths(List.of(key));
            if (r.imported() > 0) {
                status = ImportWatchItem.IMPORTED;
            } else if (r.failed() > 0) {
                status = ImportWatchItem.FAILED;
                error = reason(key, r.errors().isEmpty() ? null : r.errors().get(0));
            } else {
                status = ImportWatchItem.SKIPPED;
            }
        } catch (RuntimeException e) {
            status = ImportWatchItem.FAILED;
            error = e.toString();
        }
        record(key, size, mtime, status, error, ledger);
    }

    /** 取り込みのエラー文（{@code パス: メッセージ}。メッセージが null のことがある）から、パスと null を除いた理由。 */
    static String reason(String key, String raw) {
        String r = raw == null ? "" : raw;
        if (r.startsWith(key)) {
            r = r.substring(key.length());
            if (r.startsWith(":")) {
                r = r.substring(1);
            }
        }
        r = r.trim();
        return r.isEmpty() || r.equals("null") ? "import-failed" : r;
    }

    private void record(String key, long size, long mtime, String status, String error,
                        Map<String, ImportWatchItem> ledger) {
        ImportWatchItem item = new ImportWatchItem(key, size, mtime, status, clock.millis(), error);
        repo.save(item);
        ledger.put(key, item);
    }
}
